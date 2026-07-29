import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRunner } from "../codex-runner.mjs";
import { runProcess } from "../process.mjs";
import { resolveWorkerTemplate } from "../util.mjs";

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
  "currentBranch",
];

function parseJsonRecord(text) {
  try {
    return { value: JSON.parse(text), error: null };
  } catch (error) {
    return { value: null, error: error.message };
  }
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
  if (proof.proofVersion !== 1) invalidFields.push("proofVersion");
  if (proof.proven !== true) invalidFields.push("proven");
  for (const field of [
    "reused",
    "parentVerified",
    "nameStatusVerified",
    "treeVerified",
    "blobVerified",
    "taskBranchCreated",
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
  ]) {
    if (typeof proof[field] !== "string" || !proof[field]) {
      invalidFields.push(field);
    }
  }
  if (!Array.isArray(proof.verifiedFiles)) invalidFields.push("verifiedFiles");
  if (!Array.isArray(proof.statusAfter)) invalidFields.push("statusAfter");
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

function validateRecoveryProof(inspection, recovery, taskBranch) {
  const audit = requireInspectionAudit(inspection);
  if (
    recovery.proofVersion !== 1 ||
    recovery.proven !== true ||
    recovery.auditedHead !== audit.head ||
    recovery.preservationParent !== audit.head ||
    recovery.auditFingerprint !== audit.fingerprint ||
    !/^[0-9a-f]{40}$/iu.test(recovery.preservationCommit || "") ||
    !/^[0-9a-f]{40}$/iu.test(recovery.preservationParent || "") ||
    !/^[0-9a-f]{40}$/iu.test(recovery.preservedTree || "")
  ) {
    throw Object.assign(
      new Error(
        "Recovery proof did not match the inspected HEAD and audit fingerprint; the worker remains in attention",
      ),
      {
        code: "WORKSPACE_AUDIT_MISMATCH",
        details: { inspection, recovery },
      },
    );
  }
  if (
    recovery.parentVerified !== true ||
    recovery.nameStatusVerified !== true ||
    recovery.treeVerified !== true ||
    recovery.blobVerified !== true ||
    recovery.taskBranch !== taskBranch ||
    recovery.currentBranch !== taskBranch ||
    recovery.taskBranchCreated !== true ||
    recovery.statusAfter.length !== 0 ||
    recovery.preservationBranch !== recovery.preservedBranch ||
    recovery.preservationCommit !== recovery.preservedCommit
  ) {
    throw Object.assign(
      new Error(
        "Recovery proof did not attest a verified preservation and clean new task branch; the worker remains in attention",
      ),
      {
        code: "WORKSPACE_PRESERVATION_UNPROVEN",
        details: { inspection, recovery, taskBranch },
      },
    );
  }

  const expectedChanges = new Set(
    audit.changes.map((change) =>
      changeKey(change, expectedStatus(String(change.code || ""))),
    ),
  );
  const preservedChanges = Array.isArray(recovery.preservedNameStatus)
    ? recovery.preservedNameStatus
    : [];
  const actualChanges = new Set(
    preservedChanges.map((change) => changeKey(change)),
  );
  if (
    expectedChanges.size !== actualChanges.size ||
    [...expectedChanges].some((key) => !actualChanges.has(key))
  ) {
    throw Object.assign(
      new Error(
        "Recovery commit name-status did not exactly match the inspected change set",
      ),
      {
        code: "WORKSPACE_PRESERVATION_UNPROVEN",
        details: { inspection, recovery },
      },
    );
  }

  const preservedFiles = new Map(
    (Array.isArray(recovery.verifiedFiles) ? recovery.verifiedFiles : []).map(
      (file) => [normalizeGitPath(file.path), file],
    ),
  );
  if (
    preservedFiles.size !== recovery.verifiedFiles.length ||
    preservedFiles.size !== audit.changes.length
  ) {
    throw Object.assign(
      new Error(
        "Recovery proof contained duplicate, missing, or unexpected verified file paths",
      ),
      {
        code: "WORKSPACE_PRESERVATION_UNPROVEN",
        details: { inspection, recovery },
      },
    );
  }
  for (const audited of audit.changes) {
    const path = normalizeGitPath(audited.path);
    const preserved = preservedFiles.get(path);
    if (
      !preserved ||
      preserved.auditBlob !== audited.auditBlob ||
      preserved.preservedBlob !== audited.auditBlob
    ) {
      throw Object.assign(
        new Error(
          `Recovery commit blob for '${path}' did not match the inspection audit`,
        ),
        {
          code: "WORKSPACE_PRESERVATION_UNPROVEN",
          details: { inspection, recovery },
        },
      );
    }
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
    let result;
    try {
      result = await this.processRunner(this.config.powershellCommand, args, {
        signal,
        timeoutMs,
      });
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
      const parsedError = String(error?.stdout || "").trim()
        ? parseJsonRecord(String(error.stdout).trim()).error
        : null;
      const transport = transportRecord(error, { parseError: parsedError });
      error.operation = scriptName;
      error.code =
        error.code === "PROCESS_START_FAILED"
          ? "POWERSHELL_NOT_AVAILABLE"
          : responseContract === "recovery-proof"
            ? "RECOVERY_COMMAND_FAILED"
            : "HYPERV_COMMAND_FAILED";
      Object.assign(error, transport);
      error.details = {
        ...(error.details || {}),
        transport,
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
      { signal },
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
          GuestProjectPath: required(
            context.project.guestProjectPath,
            "project.guestProjectPath",
          ),
        },
        { signal },
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

    return this.recoverPreserved(context, inspection, {
      signal,
      onProgress,
    });
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
        GuestProjectPath: required(
          context.project.guestProjectPath,
          "project.guestProjectPath",
        ),
        TaskBranch: required(context.task.branchName, "task.branchName"),
        ExpectedHead: required(inspection.head, "inspection.head"),
        AuditedFilesJson: JSON.stringify(inspection.auditedFiles),
      },
      { signal },
    );
    const verificationStatus = normalizeNullableArray(
      result.status,
      "verification.status",
    );
    const verificationAuditedFiles = normalizeNullableArray(
      result.auditedFiles,
      "verification.auditedFiles",
    );
    if (
      result.ready !== true ||
      result.preserved !== true ||
      result.branch !== context.task.branchName ||
      result.head !== inspection.head ||
      Number(result.changedFiles) !== 0 ||
      verificationStatus.length !== 0 ||
      verificationAuditedFiles.length !== 0
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
      `Guest is on ${inspection.branch || "a detached HEAD"} at ${inspection.head}; preserving it before creating ${context.task.branchName}`,
    );
    const result = await this.powershell(
      "Recover-Workspace.ps1",
      {
        ...this.workerArguments(context.worker),
        GuestProjectPath: required(
          context.project.guestProjectPath,
          "project.guestProjectPath",
        ),
        RepoUrl: required(context.project.repoUrl, "project.repoUrl"),
        BaseBranch: required(context.task.baseBranch, "task.baseBranch"),
        TaskBranch: required(context.task.branchName, "task.branchName"),
        GitAuthorName: this.config.gitAuthorName || "Relay Unity Orchestrator",
        GitAuthorEmail:
          this.config.gitAuthorEmail || "relay-unity-orchestrator@localhost",
        AuditJson: JSON.stringify(audit),
        SharePath: context.worker.sharePath || context.project.smbPath,
      },
      { signal, responseContract: "recovery-proof" },
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
          "Recovery preparation did not return complete preservation proof; the worker remains in attention",
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
    );
    onProgress?.(
      "workspace-preserved",
      `Verified ${result.preservedBranch} at ${result.preservedCommit} before creating ${context.task.branchName}`,
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
      result.recoveryPrepared
        ? "Recovered task branch, Unity, and SMB are ready"
        : "Preserved Git branch, Unity, and SMB are ready",
    );
    return { ...result, preserved: true };
  }

  runCodex(context, options) {
    return this.codex.run(context, options);
  }

  async finalize(context, { signal, onProgress }) {
    const unitySaveUrl = resolveWorkerTemplate(
      context.project.unitySaveUrl,
      context.worker,
    );
    if (!unitySaveUrl && !this.config.allowUnitySaveSkip) {
      throw Object.assign(
        new Error(
          "unitySaveUrl is required before a Hyper-V worker can be released",
        ),
        {
          code: "UNITY_SAVE_NOT_CONFIGURED",
        },
      );
    }
    if (unitySaveUrl) {
      onProgress?.("unity-save", "Saving all Unity assets through Unity Skill");
      await this.powershell(
        "Save-UnityProject.ps1",
        {
          ...this.workerArguments(context.worker),
          UnitySaveUrl: unitySaveUrl,
        },
        { signal, timeoutMs: 120_000 },
      );
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
