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
    },
    turn: {
      id: "turn-real",
      sequence: 1,
      userMessage: "Perform a real integration test",
    },
    attachments: [],
  };
}

function recoveryProof({
  taskBranch,
  auditedHead,
  auditFingerprint,
  auditedPath,
  auditBlob,
  preservedBlob = auditBlob,
  reused = false,
}) {
  const preservationBranch =
    "relay/preserved/task-0001-real-host-task-20260727T120000000Z-acde1234abcd";
  const preservationCommit = "2".repeat(40);
  const verifiedFiles = [
    {
      path: auditedPath,
      code: "??",
      originalPath: null,
      auditBlob,
      preservedBlob,
    },
  ];
  return {
    proofVersion: 1,
    proven: true,
    auditFingerprint,
    auditedHead,
    preservationBranch,
    preservationCommit,
    preservationParent: auditedHead,
    reused,
    parentVerified: true,
    nameStatusVerified: true,
    treeVerified: true,
    blobVerified: true,
    verifiedFiles,
    statusAfter: [],
    taskBranch,
    taskBranchCreated: true,
    currentBranch: taskBranch,
    ready: true,
    branch: taskBranch,
    originalHead: auditedHead,
    preservedBranch: preservationBranch,
    preservedCommit: preservationCommit,
    preservedTree: "3".repeat(40),
    preservedNameStatus: [
      { status: "A", path: auditedPath, originalPath: null },
    ],
    preservedFiles: verifiedFiles,
    reusedPreservation: reused,
    preservationVerified: true,
    preTargetCheckoutBranch: "main",
    preTargetCheckoutHead: auditedHead,
  };
}

function recoveryInspection({
  auditedHead,
  auditFingerprint,
  auditedPath,
  auditBlob,
}) {
  return {
    ready: true,
    repositoryExists: true,
    branch: "main",
    head: auditedHead,
    porcelainV2: ["# branch.head main", `? ${auditedPath}`],
    untrackedFiles: [auditedPath],
    audit: {
      version: 1,
      branch: "main",
      head: auditedHead,
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
  const adapter = new HyperVAdapter(config(), {
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
  const processRunner = async (command, args) => {
    const name = scriptName(args);
    calls.push({ name, args });
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

test("a pre-Codex prepare failure on main uses non-destructive recovery preparation", async () => {
  const calls = [];
  const progress = [];
  const recoveryContext = context();
  recoveryContext.workspaceEstablished = false;
  const auditedMeta =
    "baloot_client/Assets/AppAssets/hall/scripts/Common/Automation.meta";
  const auditBlob = "3033568a1999ebaf6328b316315239ed67cd19a5";
  const auditFingerprint = "5".repeat(64);
  const processRunner = async (command, args) => {
    const name = scriptName(args);
    calls.push({ name, args });
    const payload =
      name === "Inspect-PreservedWorkspace.ps1"
        ? {
            ready: true,
            repositoryExists: true,
            branch: "main",
            head: "1".repeat(40),
            statusBefore: [
              { code: "??", path: auditedMeta, originalPath: null },
            ],
            auditedFiles: [
              {
                code: "??",
                path: auditedMeta,
                originalPath: null,
                auditBlob,
              },
            ],
            audit: {
              version: 1,
              branch: "main",
              head: "1".repeat(40),
              fingerprint: auditFingerprint,
              changes: [
                {
                  code: "??",
                  path: auditedMeta,
                  originalPath: null,
                  auditBlob,
                },
              ],
            },
            porcelainV2: ["# branch.head main", "? " + auditedMeta],
            untrackedFiles: [auditedMeta],
          }
        : name === "Recover-Workspace.ps1"
          ? recoveryProof({
              taskBranch: recoveryContext.task.branchName,
              auditedHead: "1".repeat(40),
              auditFingerprint,
              auditedPath: auditedMeta,
              auditBlob,
            })
          : {
              ready: true,
              vm: true,
              heartbeat: true,
              smb: true,
              unity: true,
              skill: true,
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
  assert.equal(result.proofVersion, 1);
  assert.equal(result.proven, true);
  assert.equal(result.auditedHead, "1".repeat(40));
  assert.equal(result.preservationParent, "1".repeat(40));
  assert.equal(result.parentVerified, true);
  assert.equal(result.nameStatusVerified, true);
  assert.equal(result.treeVerified, true);
  assert.equal(result.blobVerified, true);
  assert.equal(result.taskBranch, recoveryContext.task.branchName);
  assert.equal(result.taskBranchCreated, true);
  assert.equal(result.currentBranch, recoveryContext.task.branchName);
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "Inspect-PreservedWorkspace.ps1",
      "Recover-Workspace.ps1",
      "Get-WorkerHealth.ps1",
    ],
  );
  assert.equal(
    calls.some((call) =>
      [
        "Verify-PreservedWorkspace.ps1",
        "Ensure-WorkerReady.ps1",
        "Restore-Worker.ps1",
        "Control-Worker.ps1",
      ].includes(call.name),
    ),
    false,
  );
  const recovery = calls.find((call) => call.name === "Recover-Workspace.ps1");
  assert.equal(
    recovery.args[recovery.args.indexOf("-TaskBranch") + 1],
    recoveryContext.task.branchName,
  );
  assert.equal(recovery.args[recovery.args.indexOf("-BaseBranch") + 1], "main");
  assert.deepEqual(
    JSON.parse(recovery.args[recovery.args.indexOf("-AuditJson") + 1]),
    {
      version: 1,
      branch: "main",
      head: "1".repeat(40),
      fingerprint: auditFingerprint,
      changes: [
        {
          code: "??",
          path: auditedMeta,
          originalPath: null,
          auditBlob,
        },
      ],
    },
  );
  const inspectionEvidence = progress.find(
    (entry) => entry.phase === "workspace-inspected",
  );
  assert.equal(inspectionEvidence.data.branch, "main");
  assert.equal(inspectionEvidence.data.head, "1".repeat(40));
  assert.deepEqual(inspectionEvidence.data.untrackedFiles, [auditedMeta]);
  const preservationEvidence = progress.find(
    (entry) => entry.phase === "workspace-preserved",
  );
  assert.equal(preservationEvidence.data.preservationVerified, true);
  assert.equal(
    preservationEvidence.data.preservedBranch,
    result.preservedBranch,
  );
  assert.equal(
    preservationEvidence.data.preservedCommit,
    result.preservedCommit,
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
  const delivery = await adapter.finalize(context(), {});
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
});

test("Unity save receives only an explicit guest-loopback request URL instead of the corporate authority", async () => {
  const calls = [];
  const deliveredSha = "8".repeat(40);
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

  await adapter.finalize(deliveryContext, {});

  const save = calls.find((call) => call.script === "Save-UnityProject.ps1");
  assert.ok(save);
  const configuredIndex = save.args.indexOf("-UnitySaveUrl");
  const guestIndex = save.args.indexOf("-GuestUnitySkillsEndpoint");
  assert.equal(
    save.args[configuredIndex + 1],
    "http://127.0.0.1:8090/skill/editor_execute_menu",
  );
  assert.equal(save.args[guestIndex + 1], "http://127.0.0.1:8090");
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
  assert.equal(args.at(-1), "-");
  const prompt = options.input;
  assert.match(prompt, /Get-UnityDialogGuardState\.ps1/);
  assert.match(prompt, /Invoke-UnityDialogGuardAction\.ps1/);
  assert.match(prompt, /VMName unity-worker-01/);
  assert.match(prompt, /Never authorize a high-risk action/);
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
