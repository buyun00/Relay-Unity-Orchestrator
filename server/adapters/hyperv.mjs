import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRunner } from "../codex-runner.mjs";
import { runProcess } from "../process.mjs";
import { deliveryAuditFingerprint, resolveWorkerTemplate } from "../util.mjs";

const scriptsDirectory = fileURLToPath(
  new URL("../../scripts/hyperv/", import.meta.url),
);

function script(name) {
  return path.join(scriptsDirectory, name);
}

function required(value, label) {
  if (!value)
    throw Object.assign(
      new Error(`${label} is required for the Hyper-V adapter`),
      { code: "HYPERV_CONFIG_MISSING" },
    );
  return value;
}

const workspaceRefusalMarker = "RELAY_WORKSPACE_REFUSED:";
const recoveryProofFields = [
  "proofVersion",
  "proven",
  "auditFingerprint",
  "auditedHead",
  "preservationBranch",
  "preservationCommit",
  "preservationParent",
  "reused",
  "parentVerified",
  "nameStatusVerified",
  "treeVerified",
  "blobVerified",
  "verifiedFiles",
  "statusAfter",
  "taskBranch",
  "taskBranchCreated",
  "taskBranchFastForwarded",
  "currentBranch",
  "expectedRemoteTip",
  "remoteTip",
  "remoteRef",
  "remoteTipAttempts",
  "fetchAttempts",
  "branchAction",
  "localTaskHeadAfter",
  "porcelainV2After",
  "untrackedFilesAfter",
  "preservationRefCreated",
];

function parseJsonRecord(text) {
  try {
    return { value: JSON.parse(text), error: null };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

function codexStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

function deliveryAuditForFinalization(context, deliveryAudit) {
  const taskBranch = required(context.task.branchName, "task.branchName");
  const files = Array.isArray(deliveryAudit?.files)
    ? deliveryAudit.files
    : null;
  if (
    deliveryAudit?.version !== 1 ||
    deliveryAudit?.ready !== true ||
    deliveryAudit?.exact !== true ||
    deliveryAudit?.branch !== taskBranch ||
    !deliveryAudit?.head ||
    !files
  ) {
    throw Object.assign(
      new Error(
        "Delivery workspace ownership, branch, HEAD, or actual file state could not be established",
      ),
      {
        code: "DELIVERY_AUDIT_TASK_CORRECTION_REQUIRED",
        blockedPaths: Array.isArray(deliveryAudit?.blockedPaths)
          ? deliveryAudit.blockedPaths.map(String)
          : [],
        details: deliveryAudit,
      },
    );
  }

  const unsafeFiles = files.filter(
    (file) =>
      file?.unsafeReason ||
      typeof file?.path !== "string" ||
      !/^[ MA]{2}$/u.test(String(file?.code || "")) ||
      !/[MA]/u.test(String(file?.code || "")),
  );
  if (unsafeFiles.length) {
    throw Object.assign(
      new Error(
        "The actual Git workspace contains deleted, missing, untracked, renamed, or unsupported files that the task Codex must correct",
      ),
      {
        code: "DELIVERY_AUDIT_TASK_CORRECTION_REQUIRED",
        blockedPaths: unsafeFiles.map((file) => String(file?.path || "")),
        details: deliveryAudit,
      },
    );
  }

  if (
    deliveryAudit.safeForDeliveryRetry === true &&
    deliveryAudit.completeFileSet === true
  ) {
    return { audit: deliveryAudit, advisory: false };
  }

  const reportedPaths = new Set(codexStringArray(deliveryAudit.changedFiles));
  const unownedFiles = files.filter((file) => !reportedPaths.has(file.path));
  if (unownedFiles.length) {
    throw Object.assign(
      new Error(
        "The actual workspace includes files outside this task's reported change set; the task Codex must distinguish its own changes from unrelated drift",
      ),
      {
        code: "DELIVERY_AUDIT_TASK_CORRECTION_REQUIRED",
        blockedPaths: unownedFiles.map((file) => String(file.path)),
        details: deliveryAudit,
      },
    );
  }

  const audit = {
    ...deliveryAudit,
    safeForDeliveryRetry: true,
    completeFileSet: true,
    changedFiles: files.map((file) => String(file.path)),
    validation: codexStringArray(deliveryAudit.validation),
    blockedPaths: [],
    source: deliveryAudit.source || "workspace",
    message:
      "Relay used the actual tracked Git workspace within the task's reported change set; already-committed reported paths were advisory.",
  };
  audit.fingerprint = deliveryAuditFingerprint(audit);
  return { advisory: true, audit };
}

function repositoryRelativeCodexPaths(context, value) {
  const guestRoot = required(
    context.project.guestProjectPath,
    "project.guestProjectPath",
  );
  const hostRoot = required(context.worker.sharePath, "worker.sharePath");
  return codexStringArray(value).map((candidate) => {
    if (!path.win32.isAbsolute(candidate)) {
      return candidate.replaceAll("\\", "/");
    }
    for (const root of [hostRoot, guestRoot]) {
      const relative = path.win32.relative(root, candidate);
      if (
        relative &&
        relative !== ".." &&
        !relative.startsWith(`..${path.win32.sep}`) &&
        !path.win32.isAbsolute(relative)
      ) {
        return relative.replaceAll("\\", "/");
      }
    }
    throw Object.assign(
      new Error(
        `Codex reported a changed file outside the assigned project roots: '${candidate}'`,
      ),
      { code: "DELIVERY_CHANGED_FILE_OUTSIDE_PROJECT" },
    );
  });
}

function guestLocalUnitySaveUrl(configuredSaveUrl, guestEndpoint) {
  let configured;
  let guest;
  try {
    configured = new URL(configuredSaveUrl);
    guest = new URL(guestEndpoint);
  } catch (error) {
    throw Object.assign(
      new Error(
        `Unity save endpoint configuration is invalid: ${error.message}`,
      ),
      { code: "UNITY_SAVE_ENDPOINT_INVALID" },
    );
  }
  const hostname = guest.hostname.toLowerCase();
  if (
    !["http:", "https:"].includes(guest.protocol) ||
    !["127.0.0.1", "[::1]", "localhost"].includes(hostname) ||
    guest.username ||
    guest.password
  ) {
    throw Object.assign(
      new Error(
        `Guest UnitySkills endpoint '${guestEndpoint}' must use an HTTP loopback address without user information`,
      ),
      { code: "UNITY_SAVE_ENDPOINT_NOT_LOOPBACK" },
    );
  }
  if (guest.pathname === "/" && configured.pathname !== "/") {
    guest.pathname = configured.pathname;
  }
  if (!guest.search && configured.search) {
    guest.search = configured.search;
  }
  return guest.href;
}

function parseWorkspaceRefusal(error) {
  for (const text of [error?.stderr, error?.stdout, error?.message]) {
    if (!text) continue;
    const complete = parseJsonRecord(text.trim()).value;
    if (
      complete &&
      typeof complete === "object" &&
      !Array.isArray(complete) &&
      (complete.ready === false ||
        complete.proven === false ||
        complete.refusal)
    ) {
      return complete;
    }
    const markerIndex = text.lastIndexOf(workspaceRefusalMarker);
    if (markerIndex < 0) continue;
    const candidate = text
      .slice(markerIndex + workspaceRefusalMarker.length)
      .split(/\r?\n/u, 1)[0]
      .trim();
    const parsed = parseJsonRecord(candidate).value;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed.ready === false || parsed.proven === false || parsed.refusal)
    ) {
      return parsed;
    }
  }
  return null;
}

function transportRecord(
  result,
  { parseError = null, missingFields = [] } = {},
) {
  return {
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
    stdout: String(result?.stdout || ""),
    stderr: String(result?.stderr || ""),
    parseError,
    missingFields: [...missingFields],
  };
}

function recoveryTransportError(code, message, operation, transport) {
  return Object.assign(new Error(message), {
    code,
    operation,
    ...transport,
    details: { transport },
  });
}

function parseRecoveryResult(operation, result) {
  const stdout = String(result.stdout || "").trim();
  if (!stdout) {
    const transport = transportRecord(result);
    throw recoveryTransportError(
      "RECOVERY_PROOF_EMPTY_STDOUT",
      `Recovery command ${operation} exited successfully but stdout was empty`,
      operation,
      transport,
    );
  }

  const parsedRecord = parseJsonRecord(stdout);
  if (parsedRecord.error) {
    const transport = transportRecord(result, {
      parseError: parsedRecord.error,
    });
    throw recoveryTransportError(
      "RECOVERY_PROOF_JSON_INVALID",
      `Recovery command ${operation} returned invalid JSON: ${parsedRecord.error}`,
      operation,
      transport,
    );
  }
  const proof = parsedRecord.value;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    const transport = transportRecord(result, {
      parseError: "Recovery stdout JSON was not an object",
    });
    throw recoveryTransportError(
      "RECOVERY_PROOF_JSON_INVALID",
      `Recovery command ${operation} did not return one JSON object`,
      operation,
      transport,
    );
  }

  const missingFields = recoveryProofFields.filter(
    (field) => !Object.hasOwn(proof, field),
  );
  if (missingFields.length) {
    const transport = transportRecord(result, { missingFields });
    throw recoveryTransportError(
      "RECOVERY_PROOF_FIELDS_MISSING",
      `Recovery proof was missing required fields: ${missingFields.join(", ")}`,
      operation,
      transport,
    );
  }

  const invalidFields = [];
  if (proof.proofVersion !== 2) invalidFields.push("proofVersion");
  if (proof.proven !== true) invalidFields.push("proven");
  for (const field of [
    "reused",
    "parentVerified",
    "nameStatusVerified",
    "treeVerified",
    "blobVerified",
    "taskBranchCreated",
    "taskBranchFastForwarded",
    "preservationRefCreated",
  ]) {
    if (typeof proof[field] !== "boolean") invalidFields.push(field);
  }
  for (const field of [
    "auditFingerprint",
    "auditedHead",
    "preservationBranch",
    "preservationCommit",
    "preservationParent",
    "taskBranch",
    "currentBranch",
    "expectedRemoteTip",
    "remoteTip",
    "remoteRef",
    "branchAction",
    "localTaskHeadAfter",
  ]) {
    if (typeof proof[field] !== "string" || !proof[field]) {
      invalidFields.push(field);
    }
  }
  if (!Array.isArray(proof.verifiedFiles)) invalidFields.push("verifiedFiles");
  if (!Array.isArray(proof.statusAfter)) invalidFields.push("statusAfter");
  if (!Array.isArray(proof.untrackedFilesAfter))
    invalidFields.push("untrackedFilesAfter");
  if (!Array.isArray(proof.porcelainV2After))
    invalidFields.push("porcelainV2After");
  if (!Array.isArray(proof.remoteTipAttempts))
    invalidFields.push("remoteTipAttempts");
  if (!Array.isArray(proof.fetchAttempts)) invalidFields.push("fetchAttempts");
  if (invalidFields.length) {
    const transport = transportRecord(result);
    transport.invalidFields = invalidFields;
    throw Object.assign(
      recoveryTransportError(
        "RECOVERY_PROOF_FIELDS_INVALID",
        `Recovery proof contained invalid fields: ${invalidFields.join(", ")}`,
        operation,
        transport,
      ),
      { invalidFields },
    );
  }
  return proof;
}

function normalizeGitPath(value) {
  const normalized = String(value || "")
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Invalid audited Git path '${String(value)}'`);
  }
  return normalized;
}

function normalizeNullableArray(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw Object.assign(new Error(`${label} must be an array or null`), {
      code: "WORKSPACE_AUDIT_INVALID",
      details: { [label]: value },
    });
  }
  return [...value];
}

function normalizeInspection(inspection) {
  if (
    !inspection ||
    typeof inspection !== "object" ||
    Array.isArray(inspection)
  )
    return inspection;

  const topLevelAuditedFiles = normalizeNullableArray(
    inspection.auditedFiles,
    "auditedFiles",
  );
  const auditChanges = inspection.audit
    ? normalizeNullableArray(
        inspection.audit.changes ?? topLevelAuditedFiles,
        "audit.changes",
      )
    : topLevelAuditedFiles;
  return {
    ...inspection,
    statusBefore: normalizeNullableArray(
      inspection.statusBefore,
      "statusBefore",
    ),
    porcelainV2: normalizeNullableArray(inspection.porcelainV2, "porcelainV2"),
    untrackedFiles: normalizeNullableArray(
      inspection.untrackedFiles,
      "untrackedFiles",
    ),
    auditedFiles: auditChanges,
    audit: inspection.audit
      ? { ...inspection.audit, changes: auditChanges }
      : inspection.audit,
  };
}

function expectedStatus(code) {
  if (code === "??") return "A";
  if (code.includes("R")) return "R";
  if (code.includes("C")) return "C";
  if (code.includes("A")) return "A";
  if (code.includes("M")) return "M";
  return null;
}

function changeKey(change, status = change.status) {
  return [
    String(status || "")[0] || "",
    change.originalPath ? normalizeGitPath(change.originalPath) : "",
    normalizeGitPath(change.path),
  ].join("\0");
}

function requireInspectionAudit(inspection) {
  const audit = inspection?.audit;
  if (
    !audit ||
    audit.version !== 1 ||
    !/^[0-9a-f]{40}$/iu.test(audit.head || "") ||
    !/^[0-9a-f]{64}$/iu.test(audit.fingerprint || "") ||
    !Array.isArray(audit.changes)
  ) {
    throw Object.assign(
      new Error(
        "Preserved workspace inspection did not return a complete versioned audit; recovery was not attempted",
      ),
      {
        code: "WORKSPACE_AUDIT_INCOMPLETE",
        details: { inspection },
      },
    );
  }
  const keys = audit.changes.map((change) => {
    const status = expectedStatus(String(change.code || ""));
    if (!status || !/^[0-9a-f]{40}$/iu.test(change.auditBlob || "")) {
      throw Object.assign(
        new Error(`Incomplete audited file proof for '${String(change.path)}'`),
        {
          code: "WORKSPACE_AUDIT_INCOMPLETE",
          details: { inspection },
        },
      );
    }
    return changeKey(change, status);
  });
  if (new Set(keys).size !== keys.length) {
    throw Object.assign(
      new Error("Inspection audit contained duplicate paths"),
      {
        code: "WORKSPACE_AUDIT_INCOMPLETE",
        details: { inspection },
      },
    );
  }
  return audit;
}

function validateRecoveryProof(
  inspection,
  recovery,
  taskBranch,
  expectedRemoteTip,
) {
  const audit = requireInspectionAudit(inspection);
  const attemptsAreBoundedAndSuccessful = (
    attempts,
    expectedStage,
    maxTimeoutSeconds,
  ) =>
    Array.isArray(attempts) &&
    attempts.length >= 1 &&
    attempts.length <= 3 &&
    attempts.at(-1)?.exitCode === 0 &&
    attempts.at(-1)?.timedOut === false &&
    attempts.every(
      (attempt, index) =>
        attempt.attempt === index + 1 &&
        attempt.stage === expectedStage &&
        attempt.timeoutSeconds > 0 &&
        attempt.timeoutSeconds <= maxTimeoutSeconds &&
        attempt.backoffMilliseconds >= 0 &&
        attempt.backoffMilliseconds <= 4_000,
    );
  const branchActionMatches =
    (recovery.branchAction === "created" &&
      recovery.taskBranchCreated === true &&
      recovery.taskBranchFastForwarded === false) ||
    (recovery.branchAction === "existing-compatible" &&
      recovery.taskBranchCreated === false &&
      recovery.taskBranchFastForwarded === false) ||
    (recovery.branchAction === "fast-forwarded" &&
      recovery.taskBranchCreated === false &&
      recovery.taskBranchFastForwarded === true);

  if (
    recovery.proofVersion !== 2 ||
    recovery.proven !== true ||
    audit.changes.length !== 0 ||
    inspection.statusBefore.length !== 0 ||
    inspection.untrackedFiles.length !== 0 ||
    recovery.auditedHead !== audit.head ||
    recovery.originalBranch !== audit.branch ||
    recovery.originalHead !== audit.head ||
    recovery.auditFingerprint !== audit.fingerprint ||
    recovery.expectedRemoteTip !== expectedRemoteTip ||
    recovery.remoteTip !== expectedRemoteTip ||
    recovery.remoteRef !== "refs/heads/" + taskBranch ||
    recovery.taskBranch !== taskBranch ||
    recovery.currentBranch !== taskBranch ||
    recovery.head !== expectedRemoteTip ||
    recovery.localTaskHeadAfter !== expectedRemoteTip ||
    recovery.statusAfter.length !== 0 ||
    recovery.untrackedFilesAfter.length !== 0 ||
    recovery.preservationRefCreated !== false ||
    recovery.preservationRef !== null ||
    recovery.preservationBranch !== audit.branch ||
    recovery.preservationCommit !== audit.head ||
    recovery.preservationParent !== audit.head ||
    recovery.parentVerified !== true ||
    recovery.nameStatusVerified !== true ||
    recovery.treeVerified !== true ||
    recovery.blobVerified !== true ||
    recovery.verifiedFiles.length !== 0 ||
    !branchActionMatches ||
    !attemptsAreBoundedAndSuccessful(
      recovery.remoteTipAttempts,
      "remote-tip-ls-remote",
      120,
    ) ||
    !attemptsAreBoundedAndSuccessful(
      recovery.fetchAttempts,
      "task-branch-fetch",
      900,
    )
  ) {
    throw Object.assign(
      new Error(
        "Clean recovery proof did not match the inspected base workspace, durable remote tip, bounded attempt evidence, and final task branch; the workspace remains reserved",
      ),
      {
        code: "WORKSPACE_RECOVERY_PROOF_MISMATCH",
        details: {
          inspection,
          recovery,
          taskBranch,
          expectedRemoteTip,
        },
      },
    );
  }
  return audit;
}

export class HyperVAdapter {
  constructor(
    config,
    { processRunner = runProcess, codex = new CodexRunner(config) } = {},
  ) {
    this.config = config;
    this.processRunner = processRunner;
    this.codex = codex;
    this.runtime = null;
    this.runtimeCheckedAt = 0;
    this.runtimePromise = null;
    this.vmPowerShellTails = new Map();
  }

  async serializeVmPowerShell(vmName, operation) {
    const key = String(vmName).trim().toLowerCase();
    const previous = this.vmPowerShellTails.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.vmPowerShellTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.vmPowerShellTails.get(key) === tail) {
        this.vmPowerShellTails.delete(key);
      }
    }
  }

  async powershell(
    scriptName,
    namedArguments,
    { signal, timeoutMs = 15 * 60_000, responseContract = "default" } = {},
  ) {
    const args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script(scriptName),
    ];
    for (const [name, value] of Object.entries(namedArguments)) {
      if (value == null || value === "") continue;
      args.push(`-${name}`, String(value));
    }
    const run = () =>
      this.processRunner(this.config.powershellCommand, args, {
        signal,
        timeoutMs,
      });
    let result;
    try {
      result = namedArguments.VMName
        ? await this.serializeVmPowerShell(namedArguments.VMName, run)
        : await run();
    } catch (error) {
      const refusal = parseWorkspaceRefusal(error);
      if (refusal) {
        const transport = transportRecord(error);
        const blockedPaths = Array.isArray(refusal.blockedPaths)
          ? refusal.blockedPaths.map(String)
          : [];
        const fallbackMessage =
          "Workspace preparation refused" +
          (blockedPaths.length ? ": " + blockedPaths.join(", ") : "");
        throw Object.assign(new Error(refusal.message || fallbackMessage), {
          code: refusal.code || "WORKSPACE_PREPARATION_REFUSED",
          operation: scriptName,
          blockedPaths,
          exitCode: transport.exitCode,
          stdout: transport.stdout,
          stderr: transport.stderr,
          parseError: transport.parseError,
          missingFields: transport.missingFields,
          details: { ...refusal, transport },
          cause: error,
        });
      }
      const parsedFailure = String(error?.stdout || "").trim()
        ? parseJsonRecord(String(error.stdout).trim())
        : { value: null, error: null };
      const parsedError = parsedFailure.error;
      const transport = transportRecord(error, { parseError: parsedError });
      error.operation = scriptName;
      const checkpointFailure =
        scriptName === "Update-ProjectReadyCheckpoint.ps1" &&
        parsedFailure.value?.code === "CHECKPOINT_WORKSPACE_DIRTY" &&
        parsedFailure.value?.checkpointDirty
          ? parsedFailure.value
          : null;
      error.code = checkpointFailure
        ? checkpointFailure.code
        : error.code === "PROCESS_START_FAILED"
          ? "POWERSHELL_NOT_AVAILABLE"
          : responseContract === "recovery-proof"
            ? "RECOVERY_COMMAND_FAILED"
            : "HYPERV_COMMAND_FAILED";
      if (checkpointFailure) {
        error.message = checkpointFailure.message;
      }
      Object.assign(error, transport);
      error.details = {
        ...(error.details || {}),
        transport,
        ...(checkpointFailure ? { checkpointFailure } : {}),
      };
      throw error;
    }
    if (responseContract === "recovery-proof") {
      return parseRecoveryResult(scriptName, result);
    }
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    const parsed = parseJsonRecord(lines.at(-1) || "").value;
    return parsed || { stdout: result.stdout.trim() };
  }

  workerArguments(worker, { requireCredential = true } = {}) {
    const result = {
      VMName: required(worker.vmName, "worker.vmName"),
    };
    if (requireCredential) {
      result.CredentialPath = required(
        worker.credentialPath,
        "worker.credentialPath",
      );
    } else if (worker.credentialPath) {
      result.CredentialPath = worker.credentialPath;
    }
    return result;
  }

  workspaceAuditArguments() {
    return {
      ApprovedOverlayPathsJson: JSON.stringify(
        this.config.approvedOverlayPaths || [],
      ),
    };
  }

  async initialize() {
    return this.inspectRuntime({ force: true });
  }

  runtimeStatus() {
    return this.runtime;
  }

  async inspectRuntime({ force = false } = {}) {
    const fresh = this.runtime && Date.now() - this.runtimeCheckedAt < 10_000;
    if (!force && fresh) return this.runtime;
    if (this.runtimePromise) return this.runtimePromise;
    this.runtimePromise = (async () => {
      const [hyperv, codex] = await Promise.all([
        this.powershell("Get-HostStatus.ps1", {}, { timeoutMs: 45_000 }).catch(
          (error) => ({
            moduleAvailable: false,
            canManage: false,
            vmCount: 0,
            virtualMachines: [],
            error: error.message,
          }),
        ),
        this.codex.inspect(),
      ]);
      hyperv.checkpointsEnabled = this.config.checkpointsEnabled;
      const runtime = {
        ready: Boolean(
          hyperv.moduleAvailable &&
          hyperv.canManage &&
          codex.available &&
          codex.authenticated,
        ),
        checkedAt: new Date().toISOString(),
        checkpointsEnabled: this.config.checkpointsEnabled,
        hyperv,
        codex,
      };
      this.runtime = runtime;
      this.runtimeCheckedAt = Date.now();
      return runtime;
    })();
    try {
      return await this.runtimePromise;
    } finally {
      this.runtimePromise = null;
    }
  }

  async probeWorker(worker) {
    try {
      return await this.powershell(
        "Get-WorkerHealth.ps1",
        {
          ...this.workerArguments(worker, { requireCredential: false }),
          SharePath: worker.sharePath,
          TimeoutSeconds: 60,
        },
        { timeoutMs: 90_000 },
      );
    } catch (error) {
      return {
        ready: false,
        vm: false,
        heartbeat: false,
        smb: false,
        unity: false,
        skill: null,
        dialogGuard: null,
        error: error.message,
      };
    }
  }

  async prepare(context, { signal, onProgress }) {
    if (this.config.checkpointsEnabled) {
      onProgress?.(
        "restore",
        `Restoring ${context.worker.checkpointName || context.project.checkpointName}`,
      );
      await this.powershell(
        "Restore-Worker.ps1",
        {
          ...this.workerArguments(context.worker),
          CheckpointName:
            context.worker.checkpointName ||
            context.project.checkpointName ||
            "PROJECT_READY",
        },
        { signal },
      );
    } else {
      onProgress?.(
        "vm-ready",
        `Ensuring ${context.worker.vmName} and PowerShell Direct are ready`,
      );
      await this.powershell(
        "Ensure-WorkerReady.ps1",
        this.workerArguments(context.worker),
        { signal },
      );
    }
    onProgress?.(
      "workspace",
      `Preparing ${context.task.branchName} inside ${context.worker.vmName}`,
    );
    const result = await this.powershell(
      "Prepare-Workspace.ps1",
      {
        ...this.workerArguments(context.worker),
        ...this.workspaceAuditArguments(),
        GuestProjectPath: required(
          context.project.guestProjectPath,
          "project.guestProjectPath",
        ),
        RepoUrl: required(context.project.repoUrl, "project.repoUrl"),
        BaseBranch: required(context.task.baseBranch, "task.baseBranch"),
        TaskBranch: required(context.task.branchName, "task.branchName"),
        Mode: context.task.codexThreadId ? "resume" : "new",
        GitAuthorName: this.config.gitAuthorName || "Relay Unity Orchestrator",
        GitAuthorEmail:
          this.config.gitAuthorEmail || "relay-unity-orchestrator@localhost",
        SharePath: context.worker.sharePath || context.project.smbPath,
      },
      { signal, timeoutMs: 960_000 },
    );
    if (result.preservedBranch && result.preservedCommit) {
      onProgress?.(
        "workspace-preserved",
        "Preserved pre-existing guest changes on " +
          result.preservedBranch +
          " at " +
          result.preservedCommit,
      );
    }
    onProgress?.("unity", "Guest Git branch, Unity, and SMB are ready");
    return result;
  }

  async resumePreserved(context, { signal, onProgress }) {
    onProgress?.(
      "workspace-inspect",
      `Recording the current guest branch, HEAD, porcelain v2 status, and untracked files on ${context.worker.vmName}`,
    );
    const inspection = normalizeInspection(
      await this.powershell(
        "Inspect-PreservedWorkspace.ps1",
        {
          ...this.workerArguments(context.worker),
          ...this.workspaceAuditArguments(),
          GuestProjectPath: required(
            context.project.guestProjectPath,
            "project.guestProjectPath",
          ),
          TimeoutSeconds: 180,
        },
        { signal, timeoutMs: 240_000 },
      ),
    );
    if (!inspection.ready || !inspection.repositoryExists) {
      throw Object.assign(
        new Error(
          inspection.message ||
            `Preserved Git workspace was not found at ${context.project.guestProjectPath}`,
        ),
        {
          code: inspection.code || "PRESERVED_WORKSPACE_NOT_FOUND",
          details: inspection,
        },
      );
    }
    onProgress?.(
      "workspace-inspected",
      `Recorded guest branch ${inspection.branch || "(detached)"} at ${inspection.head}`,
      {
        branch: inspection.branch || null,
        head: inspection.head || null,
        porcelainV2: Array.isArray(inspection.porcelainV2)
          ? inspection.porcelainV2
          : [],
        untrackedFiles: Array.isArray(inspection.untrackedFiles)
          ? inspection.untrackedFiles
          : [],
        auditFingerprint: inspection.audit?.fingerprint || null,
        auditedFiles: Array.isArray(inspection.audit?.changes)
          ? inspection.audit.changes
          : [],
      },
    );

    const taskBranch = required(context.task.branchName, "task.branchName");
    const workspaceEstablished = Boolean(
      context.workspaceEstablished || context.task.codexThreadId,
    );
    if (!context.task.latestCommitSha && !workspaceEstablished) {
      return this.retryInitialPreparation(context, inspection, {
        signal,
        onProgress,
      });
    }
    if (inspection.branch === taskBranch) {
      if (!workspaceEstablished) {
        throw Object.assign(
          new Error(
            `Guest branch is '${taskBranch}', but Relay has no durable evidence that task workspace preparation completed; refusing preserved verification`,
          ),
          {
            code: "WORKSPACE_ESTABLISHMENT_UNPROVEN",
            details: {
              inspection,
              taskBranch,
              codexThreadId: context.task.codexThreadId || null,
              workspaceEstablished: false,
            },
          },
        );
      }
      return this.verifyPreserved(context, inspection, {
        signal,
        onProgress,
      });
    }

    if (!context.task.latestCommitSha && workspaceEstablished) {
      return this.resumeLocalDraft(context, inspection, { signal, onProgress });
    }
    return this.recoverPreserved(context, inspection, {
      signal,
      onProgress,
    });
  }

  async resumeLocalDraft(context, inspection, { signal, onProgress }) {
    onProgress?.(
      "workspace-local-draft",
      `Resuming the existing local ${context.task.branchName}; unpublished work does not require a delivery SHA`,
    );
    const result = await this.powershell(
      "Resume-LocalTaskBranch.ps1",
      {
        ...this.workerArguments(context.worker),
        GuestProjectPath: required(
          context.project.guestProjectPath,
          "project.guestProjectPath",
        ),
        TaskBranch: context.task.branchName,
        ExpectedCurrentBranch: required(inspection.branch, "inspection.branch"),
        ExpectedCurrentHead: required(inspection.head, "inspection.head"),
      },
      { signal, timeoutMs: 240_000 },
    );
    if (
      !result.ready ||
      !result.localDraft ||
      result.branch !== context.task.branchName ||
      !/^[0-9a-f]{40}$/u.test(String(result.head || "")) ||
      result.originalBranch !== inspection.branch ||
      result.originalHead !== inspection.head
    ) {
      throw Object.assign(
        new Error("Local task branch identity was not verified"),
        {
          code: "LOCAL_DRAFT_IDENTITY_UNPROVEN",
          details: result,
        },
      );
    }
    onProgress?.(
      "workspace-local-draft-resumed",
      `Resumed unpublished local commit ${result.head}`,
      result,
    );
    return this.finishPreservedResume(
      context,
      { ...result, inspection },
      { onProgress },
    );
  }

  async retryInitialPreparation(context, inspection, { signal, onProgress }) {
    onProgress?.(
      "workspace-initial-retry",
      `Retrying initial preparation of ${context.task.branchName} without restoring the checkpoint or restarting ${context.worker.vmName}`,
      {
        originalBranch: inspection.branch || null,
        originalHead: inspection.head || null,
        auditFingerprint:
          inspection.audit?.fingerprint || inspection.auditFingerprint || null,
      },
    );
    const result = await this.powershell(
      "Prepare-Workspace.ps1",
      {
        ...this.workerArguments(context.worker),
        ...this.workspaceAuditArguments(),
        GuestProjectPath: required(
          context.project.guestProjectPath,
          "project.guestProjectPath",
        ),
        RepoUrl: required(context.project.repoUrl, "project.repoUrl"),
        BaseBranch: required(context.task.baseBranch, "task.baseBranch"),
        TaskBranch: required(context.task.branchName, "task.branchName"),
        Mode: "new",
        GitAuthorName: this.config.gitAuthorName || "Relay Unity Orchestrator",
        GitAuthorEmail:
          this.config.gitAuthorEmail || "relay-unity-orchestrator@localhost",
        SharePath: context.worker.sharePath || context.project.smbPath,
      },
      { signal, timeoutMs: 960_000 },
    );
    onProgress?.(
      "workspace-initial-prepared",
      `Initial task branch ${context.task.branchName} was prepared without a checkpoint restore`,
      {
        branch: result.currentBranch || result.branch || null,
        head: result.head || null,
      },
    );
    return this.finishPreservedResume(
      context,
      {
        ...result,
        inspection,
        recoveryPrepared: false,
        initialPreparationRetried: true,
      },
      { onProgress },
    );
  }

  async verifyPreserved(context, inspection, { signal, onProgress }) {
    onProgress?.(
      "workspace",
      `Verifying preserved ${context.task.branchName} workspace without resetting it`,
    );
    const result = await this.powershell(
      "Verify-PreservedWorkspace.ps1",
      {
        ...this.workerArguments(context.worker),
        ...this.workspaceAuditArguments(),
        GuestProjectPath: required(
          context.project.guestProjectPath,
          "project.guestProjectPath",
        ),
        TaskBranch: required(context.task.branchName, "task.branchName"),
        ExpectedHead: required(inspection.head, "inspection.head"),
        AuditedFilesJson: JSON.stringify(inspection.auditedFiles),
      },
      { signal, timeoutMs: 120_000 },
    );
    const verificationStatus = normalizeNullableArray(
      result.status,
      "verification.status",
    );
    const verificationAuditedFiles = normalizeNullableArray(
      result.auditedFiles,
      "verification.auditedFiles",
    );
    const changedFiles = Number(result.changedFiles);
    const cleanVerification =
      changedFiles === 0 &&
      verificationStatus.length === 0 &&
      verificationAuditedFiles.length === 0;
    const expectedAuditFingerprint =
      inspection.audit?.fingerprint || inspection.auditFingerprint || null;
    const unchangedAuditedWorkspace =
      changedFiles > 0 &&
      result.auditMatched === true &&
      typeof expectedAuditFingerprint === "string" &&
      result.auditFingerprint === expectedAuditFingerprint &&
      result.expectedAuditFingerprint === expectedAuditFingerprint &&
      changedFiles === verificationStatus.length &&
      changedFiles === verificationAuditedFiles.length;
    if (
      result.ready !== true ||
      result.preserved !== true ||
      result.branch !== context.task.branchName ||
      result.head !== inspection.head ||
      (!cleanVerification && !unchangedAuditedWorkspace)
    ) {
      throw Object.assign(
        new Error(
          result.message ||
            `Established task branch '${context.task.branchName}' is not a clean verified workspace; refusing to resume Codex`,
        ),
        {
          code: result.code || "PRESERVED_WORKSPACE_VERIFICATION_FAILED",
          details: {
            branch: result.branch || inspection.branch || null,
            head: result.head || inspection.head || null,
            auditedFiles: inspection.auditedFiles,
            inspection,
            verification: {
              ...result,
              status: verificationStatus,
              auditedFiles: verificationAuditedFiles,
            },
            transport: result.transport || inspection.transport || null,
          },
        },
      );
    }
    if (unchangedAuditedWorkspace) {
      onProgress?.(
        "workspace-audit-verified",
        `Verified ${changedFiles} unchanged audited workspace modification(s) before resuming Codex`,
        {
          auditFingerprint: result.auditFingerprint,
          changedFiles,
          paths: verificationAuditedFiles.map((file) => file.path),
        },
      );
    }
    return this.finishPreservedResume(
      context,
      {
        ...result,
        status: verificationStatus,
        auditedFiles: verificationAuditedFiles,
        inspection,
        recoveryPrepared: false,
      },
      { onProgress },
    );
  }

  async recoverPreserved(context, inspection, { signal, onProgress }) {
    const audit = requireInspectionAudit(inspection);
    onProgress?.(
      "workspace-recovery",
      `Guest is on clean ${inspection.branch || "a detached HEAD"} at ${inspection.head}; verifying durable remote tip before recovering ${context.task.branchName}`,
    );
    const result = await this.powershell(
      "Recover-Workspace.ps1",
      {
        ...this.workerArguments(context.worker),
        ...this.workspaceAuditArguments(),
        GuestProjectPath: required(
          context.project.guestProjectPath,
          "project.guestProjectPath",
        ),
        RepoUrl: required(context.project.repoUrl, "project.repoUrl"),
        BaseBranch: required(context.task.baseBranch, "task.baseBranch"),
        TaskBranch: required(context.task.branchName, "task.branchName"),
        ExpectedRemoteTip: required(
          context.task.latestCommitSha,
          "task.latestCommitSha",
        ),
        SharePath: context.worker.sharePath || context.project.smbPath,
        GitNetworkTimeoutSeconds: 45,
        GitFetchTimeoutSeconds: 840,
        PowerShellDirectTimeoutSeconds: 900,
      },
      {
        signal,
        timeoutMs: 960_000,
        responseContract: "recovery-proof",
      },
    );
    if (
      !result.proven ||
      !result.parentVerified ||
      !result.nameStatusVerified ||
      !result.treeVerified ||
      !result.blobVerified
    ) {
      throw Object.assign(
        new Error(
          "Recovery preparation did not return complete preservation proof; the workspace remains reserved",
        ),
        {
          code: "WORKSPACE_PRESERVATION_UNPROVEN",
          details: { inspection, recovery: result },
        },
      );
    }
    validateRecoveryProof(
      inspection,
      result,
      required(context.task.branchName, "task.branchName"),
      required(context.task.latestCommitSha, "task.latestCommitSha"),
    );
    onProgress?.(
      "workspace-recovered",
      `Verified remote ${result.remoteRef} at ${result.remoteTip} and recovered ${context.task.branchName}`,
      {
        originalBranch: result.originalBranch || inspection.branch || null,
        originalHead: result.originalHead || inspection.head || null,
        porcelainV2: Array.isArray(result.porcelainV2Before)
          ? result.porcelainV2Before
          : [],
        untrackedFiles: Array.isArray(result.untrackedFilesBefore)
          ? result.untrackedFilesBefore
          : [],
        preservedBranch: result.preservationBranch,
        preservedCommit: result.preservationCommit,
        preservedTree: result.preservedTree || null,
        preservedNameStatus: Array.isArray(result.preservedNameStatus)
          ? result.preservedNameStatus
          : [],
        preservedFiles: Array.isArray(result.preservedFiles)
          ? result.preservedFiles
          : [],
        auditFingerprint: result.auditFingerprint || null,
        reusedPreservation: Boolean(result.reused),
        preservationVerified: true,
        remoteRef: result.remoteRef,
        remoteTip: result.remoteTip,
        expectedRemoteTip: result.expectedRemoteTip,
        branchAction: result.branchAction,
        remoteTipAttempts: result.remoteTipAttempts,
        fetchAttempts: result.fetchAttempts,
        preTargetCheckoutBranch: result.preTargetCheckoutBranch || null,
        preTargetCheckoutHead: result.preTargetCheckoutHead || null,
      },
    );
    return this.finishPreservedResume(
      context,
      { ...result, inspection, recoveryPrepared: true },
      { onProgress },
    );
  }

  async finishPreservedResume(context, result, { onProgress }) {
    const health = await this.probeWorker({
      ...context.worker,
      project: context.project,
    });
    if (!health.ready) {
      throw Object.assign(
        new Error(
          `Preserved workspace is intact, but the worker is not ready: ${health.error || "a core worker prerequisite is unavailable"}`,
        ),
        { code: "PRESERVED_WORKSPACE_NOT_READY" },
      );
    }
    onProgress?.(
      "unity",
      result.initialPreparationRetried
        ? "Initially prepared task branch, Unity, and SMB are ready"
        : result.recoveryPrepared
          ? "Recovered task branch, Unity, and SMB are ready"
          : "Preserved Git branch, Unity, and SMB are ready",
    );
    return { ...result, preserved: true };
  }

  runCodex(context, options) {
    return this.codex.run(context, options);
  }

  async auditDeliveryWorkspace(
    context,
    codexFinal,
    { signal, onProgress } = {},
  ) {
    onProgress?.(
      "delivery-audit",
      "Recording the exact branch, HEAD, file set, hashes, and validation output before delivery",
    );
    const result = await this.powershell(
      "Get-DeliveryWorkspaceAudit.ps1",
      {
        ...this.workerArguments(context.worker),
        ...this.workspaceAuditArguments(),
        GuestProjectPath: required(
          context.project.guestProjectPath,
          "project.guestProjectPath",
        ),
        TaskBranch: required(context.task.branchName, "task.branchName"),
        BaseRef: `refs/remotes/origin/${required(
          context.task.baseBranch,
          "task.baseBranch",
        )}`,
        ChangedFilesJson: JSON.stringify(
          repositoryRelativeCodexPaths(context, codexFinal?.changedFiles),
        ),
        ValidationJson: JSON.stringify(
          codexStringArray(codexFinal?.validation),
        ),
      },
      { signal, timeoutMs: 120_000 },
    );
    if (result?.ready !== true) {
      throw Object.assign(
        new Error(
          result?.message ||
            "The post-Codex workspace could not be recorded for safe delivery",
        ),
        {
          code: result?.code || "DELIVERY_AUDIT_FAILED",
          blockedPaths: Array.isArray(result?.blockedPaths)
            ? result.blockedPaths.map(String)
            : [],
          details: result,
        },
      );
    }
    return result;
  }

  async verifyDeliveryRetryWorkspace(
    context,
    expectedAudit,
    { signal, onProgress } = {},
  ) {
    onProgress?.(
      "delivery-retry-audit",
      "Verifying preserved output against the exact recorded delivery audit without mutation",
    );
    const result = await this.powershell(
      "Get-DeliveryWorkspaceAudit.ps1",
      {
        ...this.workerArguments(context.worker),
        ...this.workspaceAuditArguments(),
        GuestProjectPath: required(
          context.project.guestProjectPath,
          "project.guestProjectPath",
        ),
        TaskBranch: required(context.task.branchName, "task.branchName"),
        BaseRef: `refs/remotes/origin/${required(
          context.task.baseBranch,
          "task.baseBranch",
        )}`,
        ExpectedHead: required(expectedAudit?.head, "deliveryAudit.head"),
        ChangedFilesJson: JSON.stringify(
          repositoryRelativeCodexPaths(context, expectedAudit?.changedFiles),
        ),
        ValidationJson: JSON.stringify(
          codexStringArray(expectedAudit?.validation),
        ),
        ExpectedAuditJson: JSON.stringify(expectedAudit),
      },
      { signal, timeoutMs: 120_000 },
    );
    if (result?.ready !== true || result?.exact !== true) {
      throw Object.assign(
        new Error(
          result?.message ||
            "Preserved output did not match the recorded delivery audit",
        ),
        {
          code: result?.code || "DELIVERY_RETRY_AUDIT_MISMATCH",
          blockedPaths: Array.isArray(result?.blockedPaths)
            ? result.blockedPaths.map(String)
            : [],
          details: result,
        },
      );
    }
    return result;
  }

  async finalize(context, { signal, onProgress, deliveryAudit }) {
    const normalized = deliveryAuditForFinalization(context, deliveryAudit);
    const finalizationAudit = normalized.audit;
    if (normalized.advisory) {
      onProgress?.(
        "delivery-audit-advisory",
        "Codex changedFiles did not match Git; using the actual tracked workspace file set and continuing delivery",
        {
          reportedFiles: Array.isArray(deliveryAudit?.changedFiles)
            ? deliveryAudit.changedFiles.length
            : 0,
          actualFiles: finalizationAudit.files.length,
        },
      );
    }
    const configuredUnitySaveUrl = resolveWorkerTemplate(
      context.project.unitySaveUrl,
      context.worker,
    );
    if (!configuredUnitySaveUrl && !this.config.allowUnitySaveSkip) {
      throw Object.assign(
        new Error(
          "unitySaveUrl is required before a Hyper-V worker can be released",
        ),
        {
          code: "UNITY_SAVE_NOT_CONFIGURED",
        },
      );
    }
    const auditedWorkspaceFileCount = Array.isArray(finalizationAudit.files)
      ? finalizationAudit.files.length
      : 0;
    const requiresUnitySave =
      finalizationAudit.source !== "head-commit" &&
      auditedWorkspaceFileCount > 0;
    if (configuredUnitySaveUrl && requiresUnitySave) {
      const guestUnitySkillsEndpoint =
        this.config.unityGuestLocalEndpoint || "http://127.0.0.1:8090";
      const unitySaveUrl = guestLocalUnitySaveUrl(
        configuredUnitySaveUrl,
        guestUnitySkillsEndpoint,
      );
      onProgress?.("unity-save", "Saving all Unity assets through Unity Skill");
      await this.powershell(
        "Save-UnityProject.ps1",
        {
          ...this.workerArguments(context.worker),
          UnitySaveUrl: unitySaveUrl,
          GuestUnitySkillsEndpoint: guestUnitySkillsEndpoint,
        },
        { signal, timeoutMs: 120_000 },
      );
    } else if (configuredUnitySaveUrl) {
      onProgress?.(
        "unity-save",
        auditedWorkspaceFileCount === 0
          ? "Skipping Unity save because the exact audit contains no workspace changes to persist"
          : "Skipping redundant Unity save because the exact audit already comes from the committed HEAD",
        {
          source: finalizationAudit.source,
          head: finalizationAudit.head,
          auditedWorkspaceFileCount,
        },
      );
    }
    if (!normalized.advisory) {
      await this.verifyDeliveryRetryWorkspace(context, finalizationAudit, {
        signal,
        onProgress: (phase, message, data = null) =>
          onProgress?.(
            phase === "delivery-retry-audit"
              ? "delivery-audit-post-save"
              : phase,
            phase === "delivery-retry-audit"
              ? "Verifying Unity save did not change the exact audited delivery workspace"
              : message,
            data,
          ),
      });
    }
    onProgress?.("commit", "Committing changes inside the guest");
    onProgress?.(
      "push",
      `Pushing ${context.task.branchName} and verifying remote SHA`,
    );
    return this.powershell(
      "Finalize-Workspace.ps1",
      {
        ...this.workerArguments(context.worker),
        GuestProjectPath: required(
          context.project.guestProjectPath,
          "project.guestProjectPath",
        ),
        TaskBranch: required(context.task.branchName, "task.branchName"),
        CommitMessage: `task #${context.task.number} turn ${context.turn.sequence}: ${context.task.title}`,
        GitAuthorName: this.config.gitAuthorName || "Relay Unity Orchestrator",
        GitAuthorEmail:
          this.config.gitAuthorEmail || "relay-unity-orchestrator@localhost",
        ExpectedAuditJson: JSON.stringify(finalizationAudit),
      },
      { signal },
    );
  }

  async release(context, { signal, onProgress }) {
    if (!this.config.checkpointsEnabled) {
      onProgress?.(
        "release",
        "Checkpoint restore is disabled; leaving the delivered workspace in place",
      );
      return {
        ready: true,
        checkpointRestored: false,
      };
    }
    onProgress?.(
      "release",
      `Restoring ${context.worker.checkpointName || context.project.checkpointName}`,
    );
    return this.powershell(
      "Restore-Worker.ps1",
      {
        ...this.workerArguments(context.worker),
        CheckpointName:
          context.worker.checkpointName ||
          context.project.checkpointName ||
          "PROJECT_READY",
      },
      { signal },
    );
  }

  async refreshWorkerCheckpoint(
    worker,
    project,
    {
      retentionCount = 2,
      mode = "Refresh",
      useCurrentRestoredState = false,
      signal,
    } = {},
  ) {
    return this.powershell(
      "Update-ProjectReadyCheckpoint.ps1",
      {
        ...this.workerArguments(worker),
        GuestProjectPath: required(
          project.guestProjectPath,
          "project.guestProjectPath",
        ),
        RepoUrl: required(project.repoUrl, "project.repoUrl"),
        BaseBranch: required(project.defaultBranch, "project.defaultBranch"),
        CheckpointName:
          worker.checkpointName || project.checkpointName || "PROJECT_READY",
        UnitySaveUrl: required(
          resolveWorkerTemplate(project.unitySaveUrl, worker),
          "project.unitySaveUrl",
        ),
        GuestUnitySkillsEndpoint:
          this.config.unityGuestLocalEndpoint || "http://127.0.0.1:8090",
        ApprovedOverlayPathsJson: JSON.stringify(
          this.config.approvedOverlayPaths || [],
        ),
        RetentionCount: retentionCount,
        UseCurrentRestoredState: useCurrentRestoredState ? 1 : null,
        Mode: mode,
      },
      { signal, timeoutMs: 45 * 60_000 },
    );
  }

  async controlWorker(worker, action) {
    if (action === "restore" && !this.config.checkpointsEnabled) {
      throw Object.assign(
        new Error(
          "Checkpoint operations are disabled until PIPELINE_CHECKPOINTS_ENABLED=true",
        ),
        { code: "CHECKPOINTS_DISABLED" },
      );
    }
    if (action === "release" && !this.config.checkpointsEnabled) {
      return { action, checkpointRestored: false };
    }
    if (action === "restore" || action === "release") {
      return this.powershell("Restore-Worker.ps1", {
        ...this.workerArguments(worker),
        CheckpointName: worker.checkpointName || "PROJECT_READY",
      });
    }
    if (action === "probe") return this.probeWorker(worker);
    const result = await this.powershell("Control-Worker.ps1", {
      VMName: required(worker.vmName, "worker.vmName"),
      Action: action,
    });
    if (["start", "restart"].includes(action)) {
      await this.powershell(
        "Ensure-WorkerReady.ps1",
        this.workerArguments(worker),
        { timeoutMs: 270_000 },
      );
    }
    return result;
  }
}
