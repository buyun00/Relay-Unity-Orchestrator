import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HyperVAdapter } from "../../server/adapters/hyperv.mjs";
import { CodexRunner } from "../../server/codex-runner.mjs";
import { slug } from "../../server/util.mjs";

test("Codex output schema requires every declared property", () => {
  const schema = JSON.parse(
    fs.readFileSync(
      new URL("../../server/codex-output.schema.json", import.meta.url),
      "utf8",
    ),
  );

  assert.deepEqual(
    [...schema.required].sort(),
    Object.keys(schema.properties).sort(),
  );
});

test("generated Git branch slugs stay ASCII across PowerShell Direct", () => {
  assert.equal(slug("执行真实端到端连通性测试"), "task");
  assert.equal(slug("Unity 修复 Button 123"), "unity-button-123");
});

function config(overrides = {}) {
  return {
    powershellCommand: "powershell.exe",
    codexCommand: "codex",
    codexHome: "C:\\Relay\\codex-home",
    codexModel: "gpt-5.6-sol",
    codexReasoningEffort: "xhigh",
    codexServiceTier: "default",
    gitAuthorName: "Relay Test Worker",
    gitAuthorEmail: "relay-test@localhost",
    checkpointsEnabled: false,
    allowUnitySaveSkip: true,
    ...overrides,
  };
}

function scriptName(args) {
  const index = args.indexOf("-File");
  return index >= 0 ? args[index + 1].split(/[\\/]/).at(-1) : null;
}

function context() {
  return {
    worker: {
      id: "worker-real",
      name: "unity-worker-01",
      vmName: "unity-worker-01",
      credentialPath: "C:\\Relay\\secrets\\unity-worker-01.xml",
      sharePath: "\\\\172.30.240.11\\Work\\UnityProject",
      checkpointName: "PROJECT_READY",
      internalIp: "172.30.240.11",
    },
    project: {
      guestProjectPath: "D:\\Work\\UnityProject",
      repoUrl: "https://example.test/UnityProject.git",
      checkpointName: "PROJECT_READY",
      unityHealthUrl: "http://{internalIp}:8090/health",
      unitySkillUrl: "http://{internalIp}:8090/mcp",
      unitySaveUrl: null,
    },
    task: {
      id: "task-real",
      number: 1,
      title: "Real host task",
      baseBranch: "main",
      branchName: "codex/task-0001-real-host-task",
      codexThreadId: null,
      latestCommitSha: "d".repeat(40),
    },
    turn: {
      id: "turn-real",
      sequence: 1,
      userMessage: "Perform a real integration test",
      executionProfile: "unity_asset",
    },
    attachments: [],
  };
}

function exactDeliveryAudit() {
  return {
    version: 1,
    ready: true,
    exact: true,
    safeForDeliveryRetry: true,
    completeFileSet: true,
    branch: "codex/task-0001-real-host-task",
    head: "d".repeat(40),
    changedFiles: [],
    validation: ["host integration fixture"],
    files: [],
    blockedPaths: [],
    fingerprint: "a".repeat(64),
    source: "workspace",
  };
}

test("PowerShell commands are serialized per VM without blocking other workers", async () => {
  const starts = [];
  let releaseFirst;
  let markFirstStarted;
  let markOtherStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const otherStarted = new Promise((resolve) => {
    markOtherStarted = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let workerACalls = 0;
  const processRunner = async (_command, args) => {
    const vmName = args[args.indexOf("-VMName") + 1];
    starts.push(vmName);
    if (vmName === "worker-a") {
      workerACalls += 1;
      if (workerACalls === 1) {
        markFirstStarted();
        await firstGate;
      }
    } else {
      markOtherStarted();
    }
    return { exitCode: 0, stdout: '{"ready":true}', stderr: "" };
  };
  const adapter = new HyperVAdapter(config(), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });

  const first = adapter.powershell("Get-WorkerHealth.ps1", {
    VMName: "worker-a",
  });
  await firstStarted;
  const second = adapter.powershell("Inspect-PreservedWorkspace.ps1", {
    VMName: "worker-a",
  });
  const other = adapter.powershell("Get-WorkerHealth.ps1", {
    VMName: "worker-b",
  });
  await otherStarted;

  assert.equal(workerACalls, 1);
  assert.deepEqual(starts, ["worker-a", "worker-b"]);
  releaseFirst();
  await Promise.all([first, second, other]);
  assert.equal(workerACalls, 2);
  assert.deepEqual(starts, ["worker-a", "worker-b", "worker-a"]);
});

function recoveryProof({
  taskBranch,
  auditedHead,
  auditFingerprint,
  auditBlob,
  preservedBlob = auditBlob,
  expectedRemoteTip = "d".repeat(40),
  branchAction = "created",
}) {
  const attempt = (stage) => ({
    attempt: 1,
    stage,
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    timeoutSeconds: 45,
    durationMs: 10,
    transient: false,
    backoffMilliseconds: 0,
  });
  return {
    proofVersion: 2,
    proven: true,
    auditFingerprint,
    auditedHead,
    preservationBranch: "main",
    preservationCommit: auditedHead,
    preservationParent: auditedHead,
    reused: true,
    parentVerified: true,
    nameStatusVerified: true,
    treeVerified: true,
    blobVerified: preservedBlob === auditBlob,
    verifiedFiles: [],
    statusAfter: [],
    taskBranch,
    taskBranchCreated: branchAction === "created",
    taskBranchFastForwarded: branchAction === "fast-forwarded",
    currentBranch: taskBranch,
    ready: true,
    branch: taskBranch,
    head: expectedRemoteTip,
    originalBranch: "main",
    originalHead: auditedHead,
    preservedBranch: "main",
    preservedCommit: auditedHead,
    preservedTree: "3".repeat(40),
    preservedNameStatus: [],
    preservedFiles: [],
    auditedFiles: [],
    reusedPreservation: true,
    preservationVerified: true,
    preTargetCheckoutBranch: "main",
    preTargetCheckoutHead: auditedHead,
    expectedRemoteTip,
    remoteTip: expectedRemoteTip,
    remoteRef: "refs/heads/" + taskBranch,
    remoteTipAttempts: [attempt("remote-tip-ls-remote")],
    fetchAttempts: [attempt("task-branch-fetch")],
    branchAction,
    localTaskHeadBefore: null,
    localTaskHeadAfter: expectedRemoteTip,
    porcelainV2After: ["# branch.head " + taskBranch],
    untrackedFilesAfter: [],
    preservationRef: null,
    preservationRefCreated: false,
  };
}

function recoveryInspection({ auditedHead, auditFingerprint }) {
  return {
    ready: true,
    repositoryExists: true,
    branch: "main",
    head: auditedHead,
    statusBefore: [],
    porcelainV2: ["# branch.head main"],
    untrackedFiles: [],
    audit: {
      version: 1,
      branch: "main",
      head: auditedHead,
      fingerprint: auditFingerprint,
      changes: [],
    },
  };
}

test("host preflight combines real Hyper-V inventory and Codex login state", async () => {
  const calls = [];
  const processRunner = async (command, args) => {
    calls.push({ command, args });
    assert.equal(scriptName(args), "Get-HostStatus.ps1");
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        computerName: "HOST-01",
        moduleAvailable: true,
        canManage: true,
        vmCount: 2,
        virtualMachines: [
          { id: "vm-1", name: "unity-worker-01", state: "Running" },
          { id: "vm-2", name: "unity-worker-02", state: "Off" },
        ],
        error: null,
      }),
      stderr: "",
    };
  };
  const adapter = new HyperVAdapter(config(), {
    processRunner,
    codex: {
      inspect: async () => ({
        available: true,
        authenticated: true,
        version: "codex-cli 0.145.0",
      }),
    },
  });

  const runtime = await adapter.initialize();

  assert.equal(runtime.ready, true);
  assert.equal(runtime.hyperv.vmCount, 2);
  assert.equal(runtime.codex.version, "codex-cli 0.145.0");
  assert.equal(runtime.checkpointsEnabled, false);
  assert.equal(calls.length, 1);
});

test("checkpoint-disabled preparation starts the real VM without restoring a snapshot", async () => {
  const calls = [];
  const processRunner = async (command, args) => {
    const name = scriptName(args);
    calls.push(name);
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        name === "Ensure-WorkerReady.ps1"
          ? { guestReady: true, checkpointRestored: false }
          : { workspace: "\\\\172.30.240.11\\Work\\UnityProject" },
      ),
      stderr: "",
    };
  };
  const adapter = new HyperVAdapter(config(), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });

  await adapter.prepare(context(), {});
  const release = await adapter.release(context(), {});

  assert.deepEqual(calls, ["Ensure-WorkerReady.ps1", "Prepare-Workspace.ps1"]);
  assert.equal(release.checkpointRestored, false);
  await assert.rejects(
    () => adapter.controlWorker(context().worker, "restore"),
    (error) => error?.code === "CHECKPOINTS_DISABLED",
  );
});

test("worker probing and preparation omit Skill health endpoints", async () => {
  const calls = [];
  const processRunner = async (command, args) => {
    const name = scriptName(args);
    calls.push({ name, args });
    const payload =
      name === "Get-WorkerHealth.ps1"
        ? {
            ready: true,
            vm: true,
            heartbeat: true,
            smb: true,
            unity: true,
            skill: null,
            dialogGuard: null,
          }
        : { ready: true };
    return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" };
  };
  const approvedOverlayPaths = [
    "baloot_client/Packages/manifest.json",
    "baloot_client/Packages/packages-lock.json",
  ];
  const adapter = new HyperVAdapter(config({ approvedOverlayPaths }), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });
  const workerContext = context();

  await adapter.probeWorker({
    ...workerContext.worker,
    project: workerContext.project,
  });
  await adapter.prepare(workerContext, {});

  const healthProbe = calls.find(
    (call) => call.name === "Get-WorkerHealth.ps1",
  );
  const preparation = calls.find(
    (call) => call.name === "Prepare-Workspace.ps1",
  );
  assert.ok(healthProbe);
  assert.ok(preparation);
  assert.equal(healthProbe.args.includes("-HealthUrl"), false);
  assert.equal(preparation.args.includes("-UnityHealthUrl"), false);
  const approvedIndex = preparation.args.indexOf("-ApprovedOverlayPathsJson");
  assert.equal(
    preparation.args[approvedIndex + 1],
    JSON.stringify(approvedOverlayPaths),
  );
});

test("workspace audit host scripts scope approved overlays to their guest process", () => {
  for (const scriptFile of [
    "Prepare-Workspace.ps1",
    "Inspect-PreservedWorkspace.ps1",
    "Verify-PreservedWorkspace.ps1",
    "Recover-Workspace.ps1",
    "Get-DeliveryWorkspaceAudit.ps1",
  ]) {
    const source = fs.readFileSync(
      new URL(`../../scripts/hyperv/${scriptFile}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /\$ApprovedOverlayPathsJson/u, scriptFile);
    assert.match(
      source,
      /\$env:RELAY_APPROVED_OVERLAY_PATHS_JSON\s*=/u,
      scriptFile,
    );
  }
});

test("workspace preparation proves host SMB before mutating the guest workspace", () => {
  const source = fs.readFileSync(
    new URL("../../scripts/hyperv/Prepare-Workspace.ps1", import.meta.url),
    "utf8",
  );
  const smbPreflight = source.indexOf(
    "is not reachable before guest workspace preparation",
  );
  const guestPreparation = source.indexOf("Invoke-RelayPowerShellDirect");
  const smbPostflight = source.indexOf(
    "became unreachable after guest workspace preparation",
  );

  assert.ok(smbPreflight >= 0, "SMB preflight is missing");
  assert.ok(guestPreparation >= 0, "guest preparation call is missing");
  assert.ok(smbPostflight >= 0, "SMB postflight is missing");
  assert.ok(
    smbPreflight < guestPreparation,
    "SMB must be proven before the guest branch can change",
  );
  assert.ok(
    guestPreparation < smbPostflight,
    "SMB must also be rechecked after guest preparation",
  );
});

test("PowerShell readiness scripts do not probe Skill or DialogGuard", () => {
  const healthScript = fs.readFileSync(
    new URL("../../scripts/hyperv/Get-WorkerHealth.ps1", import.meta.url),
    "utf8",
  );
  const preparationScript = fs.readFileSync(
    new URL("../../scripts/hyperv/Prepare-Workspace.ps1", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(healthScript, /Invoke-WebRequest/u);
  assert.doesNotMatch(healthScript, /Name='UnityDialogGuard\.exe'/u);
  assert.doesNotMatch(healthScript, /UnityDialogGuard\\control\\state\.json/u);
  assert.match(
    healthScript,
    /ready = \$vmRunning -and \$heartbeat -and \$smb -and \$unity/u,
  );
  assert.match(healthScript, /skill = \$null/u);
  assert.match(healthScript, /dialogGuard = \$null/u);

  assert.doesNotMatch(preparationScript, /Invoke-WebRequest/u);
  assert.doesNotMatch(
    preparationScript,
    /Unity health endpoint .* did not become reachable/u,
  );
  assert.match(preparationScript, /skillReady = \$null/u);
});

test("workspace preparation surfaces structured refusal paths from PowerShell", async () => {
  const refusal = {
    ready: false,
    code: "WORKSPACE_UNSAFE_CHANGES",
    message:
      "Workspace checkout refused because deletion status was detected: Assets/Removed.prefab",
    blockedPaths: ["Assets/Removed.prefab"],
    deletionPaths: ["Assets/Removed.prefab"],
  };
  const processRunner = async (command, args) => {
    if (scriptName(args) === "Ensure-WorkerReady.ps1") {
      return { exitCode: 0, stdout: '{"ready":true}', stderr: "" };
    }
    throw Object.assign(new Error("PowerShell exited with code 42"), {
      code: "PROCESS_FAILED",
      stdout: "",
      stderr: "RELAY_WORKSPACE_REFUSED:" + JSON.stringify(refusal),
    });
  };
  const adapter = new HyperVAdapter(config(), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });

  await assert.rejects(
    () => adapter.prepare(context(), {}),
    (error) => {
      assert.equal(error.code, "WORKSPACE_UNSAFE_CHANGES");
      assert.equal(error.operation, "Prepare-Workspace.ps1");
      assert.deepEqual(error.blockedPaths, ["Assets/Removed.prefab"]);
      assert.deepEqual(error.details.deletionPaths, ["Assets/Removed.prefab"]);
      assert.match(error.message, /Assets\/Removed\.prefab/u);
      return true;
    },
  );
});

test("workspace preparation reports the verified preservation branch", async () => {
  const processRunner = async (command, args) => {
    const name = scriptName(args);
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        name === "Prepare-Workspace.ps1"
          ? {
              ready: true,
              preservedBranch:
                "relay/preserved/task-0001-real-host-task-20260727T120000000Z-acde1234abcd",
              preservedCommit: "a".repeat(40),
            }
          : { ready: true },
      ),
      stderr: "",
    };
  };
  const adapter = new HyperVAdapter(config(), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });
  const progress = [];

  await adapter.prepare(context(), {
    onProgress: (phase, message) => progress.push({ phase, message }),
  });

  const preservation = progress.find(
    (entry) => entry.phase === "workspace-preserved",
  );
  assert.match(preservation.message, /relay\/preserved\/task-0001/u);
  assert.match(preservation.message, new RegExp("a{40}", "u"));
});

test("an established task branch uses preserved verification without restart or restore", async () => {
  const calls = [];
  const preservedContext = context();
  preservedContext.task.number = 17;
  preservedContext.task.branchName = "codex/task-0017-task";
  preservedContext.task.codexThreadId = "019fa356-ef1d-75b1-b402-dd4adc895039";
  preservedContext.workspaceEstablished = true;
  const processRunner = async (command, args, options) => {
    const name = scriptName(args);
    calls.push({ name, args, options });
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        name === "Get-WorkerHealth.ps1"
          ? {
              ready: true,
              vm: true,
              heartbeat: true,
              smb: true,
              unity: true,
              skill: true,
            }
          : name === "Inspect-PreservedWorkspace.ps1"
            ? {
                ready: true,
                repositoryExists: true,
                branch: preservedContext.task.branchName,
                head: "a".repeat(40),
                porcelainV2: [
                  "# branch.head " + preservedContext.task.branchName,
                ],
                untrackedFiles: [],
                auditedFiles: null,
                audit: {
                  version: 1,
                  branch: preservedContext.task.branchName,
                  head: "a".repeat(40),
                  fingerprint: "b".repeat(64),
                  changes: null,
                },
              }
            : {
                ready: true,
                branch: preservedContext.task.branchName,
                head: "a".repeat(40),
                changedFiles: 0,
                status: null,
                auditedFiles: null,
                preserved: true,
              },
      ),
      stderr: "",
    };
  };
  const adapter = new HyperVAdapter(config(), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });

  const result = await adapter.resumePreserved(preservedContext, {});

  assert.equal(result.preserved, true);
  assert.equal(result.recoveryPrepared, false);
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "Inspect-PreservedWorkspace.ps1",
      "Verify-PreservedWorkspace.ps1",
      "Get-WorkerHealth.ps1",
    ],
  );
  const inspection = calls.find(
    (call) => call.name === "Inspect-PreservedWorkspace.ps1",
  );
  assert.equal(
    inspection.args[inspection.args.indexOf("-TimeoutSeconds") + 1],
    "180",
  );
  assert.equal(inspection.options.timeoutMs, 240_000);
  assert.equal(
    calls.some((call) =>
      [
        "Ensure-WorkerReady.ps1",
        "Restore-Worker.ps1",
        "Prepare-Workspace.ps1",
        "Recover-Workspace.ps1",
      ].includes(call.name),
    ),
    false,
  );
  const verification = calls.find(
    (call) => call.name === "Verify-PreservedWorkspace.ps1",
  );
  assert.equal(
    verification.args[verification.args.indexOf("-TaskBranch") + 1],
    preservedContext.task.branchName,
  );
  assert.equal(
    verification.args[verification.args.indexOf("-ExpectedHead") + 1],
    "a".repeat(40),
  );
  assert.deepEqual(
    JSON.parse(
      verification.args[verification.args.indexOf("-AuditedFilesJson") + 1],
    ),
    [],
  );
});

test("an unchanged audited task branch resumes without recovery or mutation", async () => {
  const calls = [];
  const preservedContext = context();
  preservedContext.task.number = 17;
  preservedContext.task.branchName = "codex/task-0017-task";
  preservedContext.task.codexThreadId = "019fa356-ef1d-75b1-b402-dd4adc895039";
  preservedContext.workspaceEstablished = true;
  const auditedFile = {
    code: "??",
    path: "baloot_client/Assets/Incident/dirty.meta",
    originalPath: null,
    auditBlob: "c".repeat(40),
  };
  const processRunner = async (command, args) => {
    const name = scriptName(args);
    calls.push({ name, args });
    const payload =
      name === "Inspect-PreservedWorkspace.ps1"
        ? {
            ready: true,
            repositoryExists: true,
            branch: preservedContext.task.branchName,
            head: "a".repeat(40),
            porcelainV2: ["? " + auditedFile.path],
            untrackedFiles: [auditedFile.path],
            auditedFiles: [auditedFile],
            audit: {
              version: 1,
              branch: preservedContext.task.branchName,
              head: "a".repeat(40),
              fingerprint: "b".repeat(64),
              changes: [auditedFile],
            },
            transport: {
              boundary: "PowerShellDirect",
              resultRecords: 1,
              auditedFilesCount: 1,
            },
          }
        : name === "Verify-PreservedWorkspace.ps1"
          ? {
              ready: true,
              preserved: true,
              code: null,
              message: "Established task branch audit is unchanged",
              branch: preservedContext.task.branchName,
              head: "a".repeat(40),
              changedFiles: 1,
              status: [{ code: "??", path: auditedFile.path }],
              auditedFiles: [auditedFile],
              auditMatched: true,
              auditFingerprint: "b".repeat(64),
              expectedAuditFingerprint: "b".repeat(64),
              transport: {
                boundary: "PowerShellDirect",
                resultRecords: 1,
                auditedFilesParameters: 1,
                auditedFilesCount: 1,
              },
            }
          : {
              ready: true,
              vm: true,
              heartbeat: true,
              smb: true,
              unity: true,
            };
    return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" };
  };
  const adapter = new HyperVAdapter(config(), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });

  const progress = [];
  const result = await adapter.resumePreserved(preservedContext, {
    onProgress: (phase, message, data) =>
      progress.push({ phase, message, data }),
  });
  assert.equal(result.preserved, true);
  assert.equal(result.auditMatched, true);
  assert.equal(
    progress.some((entry) => entry.phase === "workspace-audit-verified"),
    true,
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "Inspect-PreservedWorkspace.ps1",
      "Verify-PreservedWorkspace.ps1",
      "Get-WorkerHealth.ps1",
    ],
  );
  assert.deepEqual(
    JSON.parse(calls[1].args[calls[1].args.indexOf("-AuditedFilesJson") + 1]),
    [auditedFile],
  );
});

test("a failed initial preparation without a commit retries preparation without restoring the checkpoint", async () => {
  const calls = [];
  const retryContext = context();
  retryContext.workspaceEstablished = false;
  retryContext.task.latestCommitSha = null;
  const auditedHead = "1".repeat(40);
  const processRunner = async (command, args) => {
    const name = scriptName(args);
    calls.push({ name, args });
    const payload =
      name === "Inspect-PreservedWorkspace.ps1"
        ? recoveryInspection({
            auditedHead,
            auditFingerprint: "5".repeat(64),
          })
        : name === "Prepare-Workspace.ps1"
          ? {
              ready: true,
              branch: retryContext.task.branchName,
              currentBranch: retryContext.task.branchName,
              head: "2".repeat(40),
            }
          : {
              ready: true,
              vm: true,
              heartbeat: true,
              smb: true,
              unity: true,
            };
    return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" };
  };
  const adapter = new HyperVAdapter(config({ checkpointsEnabled: true }), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });

  const result = await adapter.resumePreserved(retryContext, {});

  assert.equal(result.preserved, true);
  assert.equal(result.initialPreparationRetried, true);
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "Inspect-PreservedWorkspace.ps1",
      "Prepare-Workspace.ps1",
      "Get-WorkerHealth.ps1",
    ],
  );
  const preparation = calls.find(
    (call) => call.name === "Prepare-Workspace.ps1",
  );
  assert.equal(preparation.args[preparation.args.indexOf("-Mode") + 1], "new");
  assert.equal(
    calls.some((call) =>
      ["Restore-Worker.ps1", "Recover-Workspace.ps1"].includes(call.name),
    ),
    false,
  );
});

test("a pre-Codex clean-main failure verifies the durable remote tip before recovery", async () => {
  const calls = [];
  const progress = [];
  const recoveryContext = context();
  recoveryContext.workspaceEstablished = false;
  const auditedHead = "1".repeat(40);
  const auditFingerprint = "5".repeat(64);
  const processRunner = async (command, args, options) => {
    const name = scriptName(args);
    calls.push({ name, args, options });
    const payload =
      name === "Inspect-PreservedWorkspace.ps1"
        ? recoveryInspection({ auditedHead, auditFingerprint })
        : name === "Recover-Workspace.ps1"
          ? recoveryProof({
              taskBranch: recoveryContext.task.branchName,
              auditedHead,
              auditFingerprint,
              auditBlob: "3".repeat(40),
              expectedRemoteTip: recoveryContext.task.latestCommitSha,
            })
          : {
              ready: true,
              vm: true,
              heartbeat: true,
              smb: true,
              unity: true,
            };
    return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" };
  };
  const adapter = new HyperVAdapter(config({ checkpointsEnabled: true }), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });

  const result = await adapter.resumePreserved(recoveryContext, {
    onProgress: (phase, message, data) =>
      progress.push({ phase, message, data }),
  });

  assert.equal(result.preserved, true);
  assert.equal(result.recoveryPrepared, true);
  assert.equal(result.proofVersion, 2);
  assert.equal(result.remoteTip, recoveryContext.task.latestCommitSha);
  assert.equal(result.expectedRemoteTip, recoveryContext.task.latestCommitSha);
  assert.equal(result.branchAction, "created");
  assert.equal(result.preservationRefCreated, false);
  assert.deepEqual(result.statusAfter, []);
  assert.deepEqual(result.untrackedFilesAfter, []);
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "Inspect-PreservedWorkspace.ps1",
      "Recover-Workspace.ps1",
      "Get-WorkerHealth.ps1",
    ],
  );
  const recovery = calls.find((call) => call.name === "Recover-Workspace.ps1");
  assert.equal(
    recovery.args[recovery.args.indexOf("-ExpectedRemoteTip") + 1],
    recoveryContext.task.latestCommitSha,
  );
  assert.equal(recovery.options.timeoutMs, 420_000);
  assert.equal(
    progress.some(
      (entry) =>
        entry.phase === "workspace-recovered" &&
        entry.data.remoteTip === recoveryContext.task.latestCommitSha,
    ),
    true,
  );
});

test("recovery proof failure stops before health, checkpoint, reset, clean, or restart", async () => {
  const calls = [];
  const recoveryContext = context();
  recoveryContext.workspaceEstablished = false;
  const auditedPath = "baloot_client/Assets/中文 技能/Automation meta.asset";
  const auditBlob = "6".repeat(40);
  const auditFingerprint = "7".repeat(64);
  const processRunner = async (command, args) => {
    const name = scriptName(args);
    calls.push(name);
    if (name === "Inspect-PreservedWorkspace.ps1") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ready: true,
          repositoryExists: true,
          branch: "main",
          head: "1".repeat(40),
          porcelainV2: ["# branch.head main"],
          untrackedFiles: [auditedPath],
          audit: {
            version: 1,
            branch: "main",
            head: "1".repeat(40),
            fingerprint: auditFingerprint,
            changes: [
              {
                code: "??",
                path: auditedPath,
                originalPath: null,
                auditBlob,
              },
            ],
          },
        }),
        stderr: "",
      };
    }
    if (name === "Recover-Workspace.ps1") {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          recoveryProof({
            taskBranch: recoveryContext.task.branchName,
            auditedHead: "1".repeat(40),
            auditFingerprint,
            auditedPath,
            auditBlob,
            preservedBlob: "8".repeat(40),
          }),
        ),
        stderr: "",
      };
    }
    throw new Error(`Unexpected call ${name}`);
  };
  const adapter = new HyperVAdapter(config({ checkpointsEnabled: true }), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });

  await assert.rejects(
    () => adapter.resumePreserved(recoveryContext, {}),
    (error) => error?.code === "WORKSPACE_PRESERVATION_UNPROVEN",
  );
  assert.deepEqual(calls, [
    "Inspect-PreservedWorkspace.ps1",
    "Recover-Workspace.ps1",
  ]);
  assert.equal(
    calls.some((name) =>
      [
        "Get-WorkerHealth.ps1",
        "Restore-Worker.ps1",
        "Ensure-WorkerReady.ps1",
        "Control-Worker.ps1",
        "Restart-Relay.ps1",
      ].includes(name),
    ),
    false,
  );
});

test("successful recovery with empty stdout is diagnosed without a fallback result", async () => {
  const calls = [];
  const recoveryContext = context();
  const auditedPath =
    "baloot_client/Assets/AppAssets/hall/scripts/Common/Automation.meta";
  const auditBlob = "3033568a1999ebaf6328b316315239ed67cd19a5";
  const auditedHead = "1".repeat(40);
  const auditFingerprint = "9".repeat(64);
  const processRunner = async (command, args) => {
    const name = scriptName(args);
    calls.push(name);
    if (name === "Inspect-PreservedWorkspace.ps1") {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          recoveryInspection({
            auditedHead,
            auditFingerprint,
            auditedPath,
            auditBlob,
          }),
        ),
        stderr: "",
      };
    }
    if (name === "Recover-Workspace.ps1") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected call ${name}`);
  };
  const adapter = new HyperVAdapter(config(), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });

  await assert.rejects(
    () => adapter.resumePreserved(recoveryContext, {}),
    (error) => {
      assert.equal(error.code, "RECOVERY_PROOF_EMPTY_STDOUT");
      assert.equal(error.operation, "Recover-Workspace.ps1");
      assert.equal(error.exitCode, 0);
      assert.equal(error.stdout, "");
      assert.equal(error.stderr, "");
      assert.equal(error.parseError, null);
      assert.deepEqual(error.missingFields, []);
      assert.deepEqual(error.details.transport, {
        exitCode: 0,
        stdout: "",
        stderr: "",
        parseError: null,
        missingFields: [],
      });
      return true;
    },
  );
  assert.deepEqual(calls, [
    "Inspect-PreservedWorkspace.ps1",
    "Recover-Workspace.ps1",
  ]);
});

test("a missing recovery proof field is recorded separately and stops before health", async () => {
  const calls = [];
  const recoveryContext = context();
  const auditedPath = "baloot_client/Assets/中文 恢复/Automation.meta";
  const auditBlob = "3033568a1999ebaf6328b316315239ed67cd19a5";
  const auditedHead = "1".repeat(40);
  const auditFingerprint = "a".repeat(64);
  const completeProof = recoveryProof({
    taskBranch: recoveryContext.task.branchName,
    auditedHead,
    auditFingerprint,
    auditedPath,
    auditBlob,
  });
  delete completeProof.blobVerified;
  const processRunner = async (command, args) => {
    const name = scriptName(args);
    calls.push(name);
    if (name === "Inspect-PreservedWorkspace.ps1") {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          recoveryInspection({
            auditedHead,
            auditFingerprint,
            auditedPath,
            auditBlob,
          }),
        ),
        stderr: "",
      };
    }
    if (name === "Recover-Workspace.ps1") {
      return {
        exitCode: 0,
        stdout: JSON.stringify(completeProof),
        stderr: "",
      };
    }
    throw new Error(`Unexpected call ${name}`);
  };
  const adapter = new HyperVAdapter(config(), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });

  await assert.rejects(
    () => adapter.resumePreserved(recoveryContext, {}),
    (error) => {
      assert.equal(error.code, "RECOVERY_PROOF_FIELDS_MISSING");
      assert.deepEqual(error.missingFields, ["blobVerified"]);
      assert.equal(error.parseError, null);
      return true;
    },
  );
  assert.deepEqual(calls, [
    "Inspect-PreservedWorkspace.ps1",
    "Recover-Workspace.ps1",
  ]);
});

test("invalid recovery JSON records the parse error independently", async () => {
  const adapter = new HyperVAdapter(config(), {
    processRunner: async () => ({
      exitCode: 0,
      stdout: '{"message":"中文\\nline",',
      stderr: "native warning",
    }),
    codex: { inspect: async () => ({}) },
  });

  await assert.rejects(
    () =>
      adapter.powershell(
        "Recover-Workspace.ps1",
        {},
        { responseContract: "recovery-proof" },
      ),
    (error) => {
      assert.equal(error.code, "RECOVERY_PROOF_JSON_INVALID");
      assert.equal(error.exitCode, 0);
      assert.match(error.parseError, /JSON/u);
      assert.equal(error.stderr, "native warning");
      assert.deepEqual(error.missingFields, []);
      return true;
    },
  );
});

test("an unproven matching task branch remains blocked without verification or recovery", async () => {
  const calls = [];
  const unprovenContext = context();
  unprovenContext.workspaceEstablished = false;
  const processRunner = async (command, args) => {
    const name = scriptName(args);
    calls.push(name);
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        ready: true,
        repositoryExists: true,
        branch: unprovenContext.task.branchName,
        head: "4".repeat(40),
        porcelainV2: ["# branch.head " + unprovenContext.task.branchName],
        untrackedFiles: [],
      }),
      stderr: "",
    };
  };
  const adapter = new HyperVAdapter(config(), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });

  await assert.rejects(
    () => adapter.resumePreserved(unprovenContext, {}),
    (error) => error?.code === "WORKSPACE_ESTABLISHMENT_UNPROVEN",
  );
  assert.deepEqual(calls, ["Inspect-PreservedWorkspace.ps1"]);
});

test("the recovery call chain contains no checkpoint, reset, clean, restore, or worker control", () => {
  const sources = [
    "Inspect-PreservedWorkspace.ps1",
    "Inspect-PreservedWorkspace.Guest.ps1",
    "Recover-Workspace.ps1",
    "Prepare-Workspace.ps1",
    "Prepare-Workspace.Guest.ps1",
    "Verify-PreservedWorkspace.ps1",
    "Verify-PreservedWorkspace.Guest.ps1",
    "Workspace-Git.ps1",
  ].map((scriptFile) =>
    fs.readFileSync(
      new URL(`../../scripts/hyperv/${scriptFile}`, import.meta.url),
      "utf8",
    ),
  );
  const recoveryChain = sources.join("\n");

  assert.doesNotMatch(
    recoveryChain,
    /(?:Restore-Worker|Ensure-WorkerReady|Control-Worker|Restart-Relay)/u,
  );
  assert.doesNotMatch(recoveryChain, /(?:'|")(?:reset|clean|restore)(?:'|")/u);
  assert.doesNotMatch(recoveryChain, /\bRemove-Item\b/u);
});

test("worker start and restart wait for PowerShell Direct before health probing", async () => {
  const calls = [];
  const processRunner = async (command, args) => {
    calls.push(scriptName(args));
    return {
      exitCode: 0,
      stdout: JSON.stringify({ ready: true }),
      stderr: "",
    };
  };
  const adapter = new HyperVAdapter(config(), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });
  const worker = context().worker;

  await adapter.controlWorker(worker, "start");
  await adapter.controlWorker(worker, "restart");
  await adapter.controlWorker(worker, "shutdown");

  assert.deepEqual(calls, [
    "Control-Worker.ps1",
    "Ensure-WorkerReady.ps1",
    "Control-Worker.ps1",
    "Ensure-WorkerReady.ps1",
    "Control-Worker.ps1",
  ]);
});

test("workspace preparation and finalization receive a repository-local Git identity", async () => {
  const calls = [];
  const deliveredSha = "9".repeat(40);
  const deliveryAudit = exactDeliveryAudit();
  const processRunner = async (command, args) => {
    calls.push({ script: scriptName(args), args });
    if (scriptName(args) === "Finalize-Workspace.ps1") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ready: true,
          commitSha: deliveredSha,
          remoteSha: deliveredSha,
          pushed: true,
          verified: true,
        }),
        stderr: "",
      };
    }
    if (scriptName(args) === "Get-DeliveryWorkspaceAudit.ps1") {
      return {
        exitCode: 0,
        stdout: JSON.stringify(deliveryAudit),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({ ready: true, commitSha: "abc123" }),
      stderr: "",
    };
  };
  const adapter = new HyperVAdapter(config(), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });

  await adapter.prepare(context(), {});
  const delivery = await adapter.finalize(context(), { deliveryAudit });
  assert.deepEqual(delivery, {
    ready: true,
    commitSha: deliveredSha,
    remoteSha: deliveredSha,
    pushed: true,
    verified: true,
  });

  const managedGitCalls = calls.filter((call) =>
    ["Prepare-Workspace.ps1", "Finalize-Workspace.ps1"].includes(call.script),
  );
  assert.equal(managedGitCalls.length, 2);
  for (const call of managedGitCalls) {
    const nameIndex = call.args.indexOf("-GitAuthorName");
    const emailIndex = call.args.indexOf("-GitAuthorEmail");
    assert.equal(call.args[nameIndex + 1], "Relay Test Worker");
    assert.equal(call.args[emailIndex + 1], "relay-test@localhost");
  }
  const finalization = calls.find(
    (call) => call.script === "Finalize-Workspace.ps1",
  );
  const auditIndex = finalization.args.indexOf("-ExpectedAuditJson");
  assert.deepEqual(
    JSON.parse(finalization.args[auditIndex + 1]),
    deliveryAudit,
  );
  assert.deepEqual(
    calls.map((call) => call.script),
    [
      "Ensure-WorkerReady.ps1",
      "Prepare-Workspace.ps1",
      "Get-DeliveryWorkspaceAudit.ps1",
      "Finalize-Workspace.ps1",
    ],
  );

  for (const scriptFile of [
    "Prepare-Workspace.Guest.ps1",
    "Finalize-Workspace.ps1",
  ]) {
    const source = fs.readFileSync(
      new URL(`../../scripts/hyperv/${scriptFile}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /config', '--local', 'user\.name'/);
    assert.match(source, /config', '--local', 'user\.email'/);
  }
  const finalizeSource = fs.readFileSync(
    new URL("../../scripts/hyperv/Finalize-Workspace.ps1", import.meta.url),
    "utf8",
  );
  assert.match(finalizeSource, /ExpectedAuditJson/);
  assert.match(finalizeSource, /Assert-ExactAuditedWorkspace/);
  assert.match(finalizeSource, /DELIVERY_WORKSPACE_CHANGED_AFTER_AUDIT/);
  assert.doesNotMatch(finalizeSource, /Invoke-Git\s+@\('add',\s*'-A'/);
});

test("delivery audit converts assigned host and guest absolute paths to repository-relative paths", async () => {
  const calls = [];
  const deliveryAudit = exactDeliveryAudit();
  const processRunner = async (command, args) => {
    calls.push({ script: scriptName(args), args });
    return {
      exitCode: 0,
      stdout: JSON.stringify(deliveryAudit),
      stderr: "",
    };
  };
  const adapter = new HyperVAdapter(config(), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });

  await adapter.auditDeliveryWorkspace(context(), {
    changedFiles: [
      "\\\\172.30.240.11\\Work\\UnityProject\\Assets\\Host.cs",
      "D:\\Work\\UnityProject\\Assets\\Guest.cs",
      "Assets\\Relative.cs",
    ],
    validation: [],
  });

  const audit = calls.find(
    (call) => call.script === "Get-DeliveryWorkspaceAudit.ps1",
  );
  const changedFilesIndex = audit.args.indexOf("-ChangedFilesJson");
  assert.deepEqual(JSON.parse(audit.args[changedFilesIndex + 1]), [
    "Assets/Host.cs",
    "Assets/Guest.cs",
    "Assets/Relative.cs",
  ]);
});

test("delivery audit rejects absolute changed files outside assigned project roots", async () => {
  const adapter = new HyperVAdapter(config(), {
    processRunner: async () => {
      throw new Error(
        "PowerShell must not run for an out-of-root changed file",
      );
    },
    codex: { inspect: async () => ({}) },
  });

  await assert.rejects(
    adapter.auditDeliveryWorkspace(context(), {
      changedFiles: ["C:\\outside\\Unexpected.cs"],
      validation: [],
    }),
    (error) => error.code === "DELIVERY_CHANGED_FILE_OUTSIDE_PROJECT",
  );
});

test("Codex changedFiles mismatch is advisory when the actual tracked workspace is safe", async () => {
  const calls = [];
  const deliveredSha = "8".repeat(40);
  const processRunner = async (_command, args) => {
    calls.push({ script: scriptName(args), args });
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        commitSha: deliveredSha,
        remoteSha: deliveredSha,
        pushed: true,
        verified: true,
      }),
      stderr: "",
    };
  };
  const adapter = new HyperVAdapter(config(), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });
  const audit = {
    ...exactDeliveryAudit(),
    safeForDeliveryRetry: false,
    completeFileSet: false,
    changedFiles: ["Assets/AlreadyCommitted.cs"],
    blockedPaths: ["Assets/AlreadyCommitted.cs"],
    files: [],
  };
  const progress = [];

  const result = await adapter.finalize(context(), {
    deliveryAudit: audit,
    onProgress: (phase) => progress.push(phase),
  });

  assert.equal(result.commitSha, deliveredSha);
  assert.deepEqual(
    calls.map((call) => call.script),
    ["Finalize-Workspace.ps1"],
  );
  assert.ok(progress.includes("delivery-audit-advisory"));
  const expectedAuditIndex = calls[0].args.indexOf("-ExpectedAuditJson");
  const normalized = JSON.parse(calls[0].args[expectedAuditIndex + 1]);
  assert.equal(normalized.safeForDeliveryRetry, true);
  assert.equal(normalized.completeFileSet, true);
  assert.deepEqual(normalized.changedFiles, []);
  assert.deepEqual(normalized.blockedPaths, []);
});

test("actual deletion remains a hard safety stop for task-level correction", async () => {
  const calls = [];
  const adapter = new HyperVAdapter(config(), {
    processRunner: async (_command, args) => {
      calls.push({ script: scriptName(args), args });
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
    codex: { inspect: async () => ({}) },
  });
  const audit = {
    ...exactDeliveryAudit(),
    safeForDeliveryRetry: false,
    completeFileSet: true,
    changedFiles: ["Assets/Removed.prefab"],
    blockedPaths: ["Assets/Removed.prefab"],
    files: [
      {
        code: " D",
        path: "Assets/Removed.prefab",
        originalPath: null,
        gitBlob: "",
        sha256: "",
        unsafeReason: "deleted",
      },
    ],
  };

  await assert.rejects(
    adapter.finalize(context(), { deliveryAudit: audit }),
    (error) =>
      error.code === "DELIVERY_AUDIT_TASK_CORRECTION_REQUIRED" &&
      error.blockedPaths.includes("Assets/Removed.prefab"),
  );
  assert.deepEqual(calls, []);
});

test("unrelated tracked drift is never normalized into the task commit", async () => {
  const calls = [];
  const adapter = new HyperVAdapter(config(), {
    processRunner: async (_command, args) => {
      calls.push({ script: scriptName(args), args });
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
    codex: { inspect: async () => ({}) },
  });
  const audit = {
    ...exactDeliveryAudit(),
    safeForDeliveryRetry: false,
    completeFileSet: false,
    changedFiles: ["Assets/TaskChange.cs"],
    blockedPaths: ["Assets/TaskChange.cs", "Assets/Launcher.unity"],
    files: [
      {
        code: " M",
        path: "Assets/Launcher.unity",
        originalPath: null,
        gitBlob: "1".repeat(40),
        sha256: "2".repeat(64),
        unsafeReason: null,
      },
    ],
  };

  await assert.rejects(
    adapter.finalize(context(), { deliveryAudit: audit }),
    (error) =>
      error.code === "DELIVERY_AUDIT_TASK_CORRECTION_REQUIRED" &&
      error.blockedPaths.includes("Assets/Launcher.unity"),
  );
  assert.deepEqual(calls, []);
});

test("Unity save receives only an explicit guest-loopback request URL instead of the corporate authority", async () => {
  const calls = [];
  const deliveredSha = "8".repeat(40);
  const deliveryAudit = exactDeliveryAudit();
  const processRunner = async (command, args) => {
    calls.push({ script: scriptName(args), args });
    if (scriptName(args) === "Finalize-Workspace.ps1") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          commitSha: deliveredSha,
          remoteSha: deliveredSha,
          pushed: true,
          verified: true,
        }),
        stderr: "",
      };
    }
    if (scriptName(args) === "Get-DeliveryWorkspaceAudit.ps1") {
      return {
        exitCode: 0,
        stdout: JSON.stringify(deliveryAudit),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({ saved: true }),
      stderr: "",
    };
  };
  const adapter = new HyperVAdapter(
    config({
      allowUnitySaveSkip: false,
      unityGuestLocalEndpoint: "http://127.0.0.1:8090",
    }),
    { processRunner, codex: { inspect: async () => ({}) } },
  );
  const deliveryContext = context();
  deliveryContext.worker.corporateIp = "10.100.3.44";
  deliveryContext.project.unitySaveUrl =
    "http://{corporateIp}:8090/skill/editor_execute_menu";

  await adapter.finalize(deliveryContext, { deliveryAudit });

  const save = calls.find((call) => call.script === "Save-UnityProject.ps1");
  assert.ok(save);
  const configuredIndex = save.args.indexOf("-UnitySaveUrl");
  const guestIndex = save.args.indexOf("-GuestUnitySkillsEndpoint");
  assert.equal(
    save.args[configuredIndex + 1],
    "http://127.0.0.1:8090/skill/editor_execute_menu",
  );
  assert.equal(save.args[guestIndex + 1], "http://127.0.0.1:8090");
  assert.deepEqual(
    calls.map((call) => call.script),
    [
      "Save-UnityProject.ps1",
      "Get-DeliveryWorkspaceAudit.ps1",
      "Finalize-Workspace.ps1",
    ],
  );
});

test("committed HEAD delivery skips redundant Unity save before exact verification", async () => {
  const calls = [];
  const deliveredSha = "7".repeat(40);
  const deliveryAudit = {
    ...exactDeliveryAudit(),
    source: "head-commit",
  };
  const processRunner = async (command, args) => {
    const script = scriptName(args);
    calls.push(script);
    assert.notEqual(script, "Save-UnityProject.ps1");
    if (script === "Get-DeliveryWorkspaceAudit.ps1") {
      return {
        exitCode: 0,
        stdout: JSON.stringify(deliveryAudit),
        stderr: "",
      };
    }
    if (script === "Finalize-Workspace.ps1") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          commitSha: deliveredSha,
          remoteSha: deliveredSha,
          pushed: true,
          verified: true,
        }),
        stderr: "",
      };
    }
    throw new Error(`Unexpected PowerShell script: ${script}`);
  };
  const adapter = new HyperVAdapter(
    config({
      allowUnitySaveSkip: false,
      unityGuestLocalEndpoint: "http://127.0.0.1:8090",
    }),
    { processRunner, codex: { inspect: async () => ({}) } },
  );
  const deliveryContext = context();
  deliveryContext.project.unitySaveUrl =
    "http://{internalIp}:8090/skill/editor_execute_menu";

  const progress = [];
  await adapter.finalize(deliveryContext, {
    deliveryAudit,
    onProgress: (phase, message, data) =>
      progress.push({ phase, message, data }),
  });

  assert.deepEqual(calls, [
    "Get-DeliveryWorkspaceAudit.ps1",
    "Finalize-Workspace.ps1",
  ]);
  assert.ok(
    progress.some(
      (entry) =>
        entry.phase === "unity-save" &&
        entry.data?.source === "head-commit" &&
        entry.data?.head === deliveryAudit.head,
    ),
  );
});

test("checkpoint refresh resolves project Unity URLs for the selected worker", async () => {
  const calls = [];
  const processRunner = async (command, args) => {
    calls.push({ script: scriptName(args), args });
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };
  const adapter = new HyperVAdapter(config(), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });
  const refreshContext = context();
  refreshContext.project.defaultBranch = "main";
  refreshContext.project.unitySaveUrl =
    "http://{internalIp}:8090/skill/editor_execute_menu";

  await adapter.refreshWorkerCheckpoint(
    refreshContext.worker,
    refreshContext.project,
  );

  const refresh = calls.find(
    (call) => call.script === "Update-ProjectReadyCheckpoint.ps1",
  );
  assert.ok(refresh);
  const unitySaveIndex = refresh.args.indexOf("-UnitySaveUrl");
  assert.equal(
    refresh.args[unitySaveIndex + 1],
    "http://172.30.240.11:8090/skill/editor_execute_menu",
  );
});

test("Codex preflight uses the configured executable and persistent CODEX_HOME", async () => {
  const calls = [];
  const runtimeDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-codex-runtime-"),
  );
  fs.writeFileSync(path.join(runtimeDirectory, "codex.exe"), "");
  const runner = new CodexRunner(config(), {
    runtimeDirectoryResolver: () => runtimeDirectory,
    processRunner: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[0] === "--version") {
        return {
          exitCode: 0,
          stdout: "codex-cli 0.145.0\n",
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: "Logged in using ChatGPT\n",
        stderr: "",
      };
    },
  });
  try {
    const status = await runner.inspect();

    assert.equal(status.available, true);
    assert.equal(status.authenticated, true);
    assert.equal(status.version, "codex-cli 0.145.0");
    assert.equal(status.command, path.join(runtimeDirectory, "codex.exe"));
    assert.deepEqual(
      calls.map((call) => call.args),
      [["--version"], ["login", "status"]],
    );
    assert.ok(
      calls.every(
        (call) =>
          call.command === path.join(runtimeDirectory, "codex.exe") &&
          call.options.env.CODEX_HOME === "C:\\Relay\\codex-home" &&
          call.options.env.PATH.split(path.delimiter)[0] === runtimeDirectory,
      ),
    );
  } finally {
    fs.rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("Codex turns pin the Relay model, reasoning effort, and standard speed", async (t) => {
  const logDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-codex-runner-"),
  );
  t.after(() => fs.rmSync(logDirectory, { recursive: true, force: true }));
  const calls = [];
  const runner = new CodexRunner(config({ logDirectory }), {
    processRunner: async (command, args, options) => {
      calls.push({ command, args, options });
      options.onStdout?.(
        `${JSON.stringify({
          type: "thread.started",
          thread_id: "thread-model-defaults",
        })}\n`,
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const result = await runner.run(context(), {});

  assert.equal(result.threadId, "thread-model-defaults");
  assert.equal(calls.length, 1);
  const [{ args, options }] = calls;
  const execIndex = args.indexOf("exec");
  assert.ok(execIndex > 0);
  assert.ok(args.indexOf("--model") < execIndex);
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-sol");
  assert.ok(args.indexOf('model_reasoning_effort="xhigh"') < execIndex);
  assert.ok(args.indexOf('service_tier="default"') < execIndex);
  assert.ok(args.indexOf("features.fast_mode=false") < execIndex);
  assert.ok(args.includes("mcp_servers.unity.required=true"));
  assert.equal(args.at(-1), "-");
  const prompt = options.input;
  assert.match(prompt, /Get-UnityDialogGuardState\.ps1/);
  assert.match(prompt, /Invoke-UnityDialogGuardAction\.ps1/);
  assert.match(prompt, /VMName unity-worker-01/);
  assert.match(prompt, /Never authorize a high-risk action/);
});

test("Relay execution profiles keep code turns away from Unity and gate auto escalation", async (t) => {
  const logDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-codex-runner-route-"),
  );
  t.after(() => fs.rmSync(logDirectory, { recursive: true, force: true }));
  const calls = [];
  const runner = new CodexRunner(config({ logDirectory }), {
    processRunner: async (command, args, options) => {
      calls.push({ command, args, options });
      options.onStdout?.(
        `${JSON.stringify({
          type: "thread.started",
          thread_id: `thread-route-${calls.length}`,
        })}\n`,
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const codeContext = context();
  codeContext.turn.executionProfile = "code_only";
  await runner.run(codeContext, {});
  const codeCall = calls.at(-1);
  assert.match(codeCall.options.input, /executionProfile=code_only/);
  assert.match(
    codeCall.options.input,
    /Do not probe, start, wait for, restart, or repair Unity/,
  );
  assert.doesNotMatch(codeCall.options.input, /Get-UnityDialogGuardState\.ps1/);
  assert.ok(!codeCall.args.some((arg) => arg.includes("mcp_servers.unity")));

  const autoContext = context();
  autoContext.turn.executionProfile = "auto";
  await runner.run(autoContext, {});
  const autoCall = calls.at(-1);
  assert.match(autoCall.options.input, /executionProfile=auto/);
  assert.match(
    autoCall.options.input,
    /exact serialized asset or Editor operation/,
  );
  assert.match(autoCall.options.input, /Only after that explicit escalation/);
  assert.match(
    autoCall.options.input,
    /authoritative Unity endpoint for this assigned Worker unity-worker-01 is http:\/\/172\.30\.240\.11:8090/,
  );
  assert.match(
    autoCall.options.input,
    /Never send Unity or UnitySkills requests to a different Worker/,
  );
  assert.ok(!autoCall.args.some((arg) => arg.includes("mcp_servers.unity")));
});

test("Unity routing falls back to the assigned Worker's resolved health origin", async (t) => {
  const logDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-codex-runner-unity-route-"),
  );
  t.after(() => fs.rmSync(logDirectory, { recursive: true, force: true }));
  const calls = [];
  const runner = new CodexRunner(config({ logDirectory }), {
    processRunner: async (command, args, options) => {
      calls.push({ command, args, options });
      options.onStdout?.(
        `${JSON.stringify({
          type: "thread.started",
          thread_id: "thread-worker-unity-route",
        })}\n`,
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  const routedContext = context();
  routedContext.worker.name = "unity-worker-02";
  routedContext.worker.internalIp = "172.30.240.12";
  routedContext.project.unitySkillUrl = null;

  await runner.run(routedContext, {});

  const call = calls.at(-1);
  assert.match(
    call.options.input,
    /assigned Worker unity-worker-02 is http:\/\/172\.30\.240\.12:8090/,
  );
  assert.ok(
    call.args.includes('mcp_servers.unity.url="http://172.30.240.12:8090/mcp"'),
  );
});

test("task 17 invokes Codex resume with the existing durable thread instead of starting a new one", async (t) => {
  const logDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-codex-runner-resume-"),
  );
  t.after(() => fs.rmSync(logDirectory, { recursive: true, force: true }));
  const calls = [];
  const runner = new CodexRunner(config({ logDirectory }), {
    processRunner: async (command, args, options) => {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  const taskContext = context();
  const threadId = "019fa356-ef1d-75b1-b402-dd4adc895039";
  taskContext.task.number = 17;
  taskContext.task.branchName = "codex/task-0017-task";
  taskContext.task.codexThreadId = threadId;

  const result = await runner.run(taskContext, {});

  assert.equal(result.threadId, threadId);
  assert.equal(calls.length, 1);
  const [{ args }] = calls;
  const execIndex = args.indexOf("exec");
  assert.equal(args[execIndex + 1], "resume");
  assert.deepEqual(args.slice(-3), ["--", threadId, "-"]);
});

test("Codex turns use task-level model, reasoning, and Fast overrides", async (t) => {
  const logDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-codex-runner-fast-"),
  );
  t.after(() => fs.rmSync(logDirectory, { recursive: true, force: true }));
  const calls = [];
  const runner = new CodexRunner(config({ logDirectory }), {
    processRunner: async (command, args, options) => {
      calls.push({ command, args, options });
      options.onStdout?.(
        `${JSON.stringify({
          type: "thread.started",
          thread_id: "thread-task-codex-settings",
        })}\n`,
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  const taskContext = context();
  taskContext.task.codexModel = "gpt-5.6-terra";
  taskContext.task.codexReasoningEffort = "max";
  taskContext.task.codexFastMode = true;

  const result = await runner.run(taskContext, {});

  assert.equal(result.threadId, "thread-task-codex-settings");
  const [{ args }] = calls;
  const execIndex = args.indexOf("exec");
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-terra");
  assert.ok(args.indexOf('model_reasoning_effort="max"') < execIndex);
  assert.ok(args.indexOf('service_tier="fast"') < execIndex);
  assert.ok(args.indexOf("features.fast_mode=true") < execIndex);
});

test("Codex image arguments cannot consume the positional prompt", async (t) => {
  const logDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-codex-runner-image-"),
  );
  t.after(() => fs.rmSync(logDirectory, { recursive: true, force: true }));
  const calls = [];
  const runner = new CodexRunner(config({ logDirectory }), {
    processRunner: async (command, args, options) => {
      calls.push({ command, args, options });
      options.onStdout?.(
        `${JSON.stringify({
          type: "thread.started",
          thread_id: "thread-image-prompt",
        })}\n`,
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  const imageContext = context();
  imageContext.attachments = [
    {
      filename: "reference.png",
      path: "C:\\Relay\\uploads\\reference.png",
      contentType: "image/png",
    },
  ];

  await runner.run(imageContext, {});

  const [{ args, options }] = calls;
  const imageIndex = args.indexOf("--image");
  const delimiterIndex = args.indexOf("--");
  assert.ok(imageIndex > args.indexOf("exec"));
  assert.equal(args[imageIndex + 1], imageContext.attachments[0].path);
  assert.ok(delimiterIndex > imageIndex);
  assert.equal(args.length, delimiterIndex + 2);
  assert.equal(args[delimiterIndex + 1], "-");
  assert.match(options.input, /Perform a real integration test/);
  assert.match(options.input, /reference\.png/);
});
