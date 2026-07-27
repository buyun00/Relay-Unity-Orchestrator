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
                "relay/preserved/codex-task-0001-real-host-task-20260727T120000000Z",
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
  assert.match(preservation.message, /relay\/preserved\/codex-task-0001/u);
  assert.match(preservation.message, new RegExp("a{40}", "u"));
});

test("preserved workspace continuation verifies readiness without restore or Git reset", async () => {
  const calls = [];
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
          : { ready: true, branch: context().task.branchName, preserved: true },
      ),
      stderr: "",
    };
  };
  const adapter = new HyperVAdapter(config(), {
    processRunner,
    codex: { inspect: async () => ({}) },
  });

  const result = await adapter.resumePreserved(context(), {});

  assert.equal(result.preserved, true);
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "Ensure-WorkerReady.ps1",
      "Verify-PreservedWorkspace.ps1",
      "Get-WorkerHealth.ps1",
    ],
  );
  assert.equal(
    calls.some((call) =>
      ["Restore-Worker.ps1", "Prepare-Workspace.ps1"].includes(call.name),
    ),
    false,
  );
  const verification = calls.find(
    (call) => call.name === "Verify-PreservedWorkspace.ps1",
  );
  assert.equal(
    verification.args[verification.args.indexOf("-TaskBranch") + 1],
    context().task.branchName,
  );
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
  const processRunner = async (command, args) => {
    calls.push({ script: scriptName(args), args });
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
  await adapter.finalize(context(), {});

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

test("Codex preflight uses the configured executable and persistent CODEX_HOME", async () => {
  const calls = [];
  const runner = new CodexRunner(config(), {
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

  const status = await runner.inspect();

  assert.equal(status.available, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.version, "codex-cli 0.145.0");
  assert.deepEqual(
    calls.map((call) => call.args),
    [["--version"], ["login", "status"]],
  );
  assert.ok(
    calls.every(
      (call) => call.options.env.CODEX_HOME === "C:\\Relay\\codex-home",
    ),
  );
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
