import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FakeAdapter } from "./fake-adapter.mjs";
import { Store } from "../../server/db.mjs";
import { PipelineHttpServer } from "../../server/http.mjs";
import { OpsEngine } from "../../server/ops-engine.mjs";
import { Scheduler } from "../../server/scheduler.mjs";

function configFor(dataDirectory) {
  return {
    version: "ops-test",
    projectRoot: path.resolve("."),
    dataDirectory,
    databasePath: path.join(dataDirectory, "pipeline.sqlite"),
    uploadDirectory: path.join(dataDirectory, "uploads"),
    logDirectory: path.join(dataDirectory, "logs"),
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: [],
    requestBodyLimitBytes: 2 * 1024 * 1024,
    adapter: "test",
    schedulerIntervalMs: 5,
    healthIntervalMs: 60_000,
    phaseMs: 1,
    opsEnabled: true,
    opsAutoHandle: true,
    opsAutoDeploy: false,
    opsMaxAttempts: 4,
    opsMaxConcurrentSessions: 4,
    opsSupervisorIntervalMs: 60_000,
    codexModel: "test-model",
    codexReasoningEffort: "high",
    codexServiceTier: "default",
    opsCodexModel: "test-model",
    opsCodexReasoningEffort: "high",
    opsCodexFastMode: false,
    opsRepairCodexModel: "gpt-5.6-sol",
    opsRepairCodexReasoningEffort: "xhigh",
    opsRepairCodexFastMode: false,
    opsRepairCodexTimeoutMs: 0,
    opsRepairTaskStartWaitMs: 10,
  };
}

function seed(store) {
  const project = store.createProject({
    id: "ops-project",
    name: "Ops Unity Project",
    repoUrl: "https://example.invalid/ops.git",
    defaultBranch: "main",
    guestProjectPath: "D:\\Work\\ops",
    smbPath: "\\\\172.30.240.11\\Work\\ops",
    unityVersion: "2022.3 LTS",
    unitySkillUrl: "http://{internalIp}:8090/mcp",
    unityHealthUrl: "http://{internalIp}:8090/health",
    unitySaveUrl: "http://{internalIp}:8090/api/save",
    checkpointName: "PROJECT_READY",
  });
  const worker = store.createWorker({
    id: "ops-worker",
    name: "ops-worker",
    vmName: "ops-worker",
    projectId: project.id,
    checkpointName: "PROJECT_READY",
    internalIp: "172.30.240.11",
    sharePath: project.smbPath,
    status: "ready",
  });
  return { project, worker };
}

async function waitUntil(predicate, description, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

class FakeOpsSession {
  calls = [];

  async run(options) {
    this.calls.push(options);
    options.onEvent?.({
      type: "thread.started",
      thread_id: "ops-codex-thread",
    });
    options.onEvent?.({
      type: "item.completed",
      item: {
        id: `ops-agent-${this.calls.length}`,
        type: "agent_message",
        text: "I found the failure and am resuming the preserved task safely.",
      },
    });
    const incidentTurn = options.prompt.includes(
      "Automatically diagnose and recover this Relay incident now.",
    );
    return {
      threadId: "ops-codex-thread",
      final: {
        status: incidentTurn ? "action_required" : "resolved",
        summary: incidentTurn
          ? "Queued a corrective continuation on the preserved workspace."
          : "The requested system inspection completed.",
        diagnosis: incidentTurn
          ? "The original task prompt intentionally triggered a fake Codex failure."
          : "No active fault remains.",
        confidence: 0.99,
        actions: incidentTurn
          ? [
              {
                type: "task.continue",
                targetId: null,
                message:
                  "Continue from the preserved workspace and complete the task without the synthetic failure marker.",
                reason:
                  "The existing worker and Codex thread contain the required context.",
              },
            ]
          : [],
        verification: "Wait for turn.delivered from the resumed task.",
      },
    };
  }
}

class ParallelOpsSession {
  calls = [];
  active = 0;
  maxActive = 0;

  async run(options) {
    const callNumber = this.calls.length + 1;
    this.calls.push(options);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 60));
    this.active -= 1;
    const threadId = options.threadId || `parallel-codex-${callNumber}`;
    options.onEvent?.({
      type: "thread.started",
      thread_id: threadId,
    });
    return {
      threadId,
      final: {
        status: "resolved",
        summary: "Parallel conversation completed.",
        diagnosis: "No fault.",
        confidence: 1,
        actions: [],
        verification: "Conversation result persisted.",
      },
    };
  }
}

class ActionProposingOpsSession {
  calls = [];

  constructor(taskId) {
    this.taskId = taskId;
  }

  async run(options) {
    this.calls.push(options);
    options.onEvent?.({
      type: "codex.stderr",
      message:
        "ERROR codex_core::tools::router: collab spawn failed: no thread with id",
    });
    return {
      threadId: "action-policy-codex-thread",
      final: {
        status: "action_required",
        summary: "The task can be continued from its preserved workspace.",
        diagnosis:
          "Git refused checkout because local files would be overwritten.",
        confidence: 0.99,
        actions: [
          {
            type: "task.continue",
            targetId: this.taskId,
            message: "Continue the preserved task safely.",
            reason: "The workspace contains the required state.",
          },
        ],
        verification: "Wait for the continued task turn.",
      },
    };
  }
}

class PersistentSupervisorSession {
  calls = [];

  constructor(taskId = null) {
    this.taskId = taskId;
  }

  async run(options) {
    this.calls.push(options);
    options.onEvent?.({
      type: "thread.started",
      thread_id: "persistent-luna-supervisor",
    });
    return {
      threadId: "persistent-luna-supervisor",
      final: {
        status: this.taskId ? "action_required" : "monitoring",
        summary: this.taskId
          ? "A fresh unrestricted recovery conversation is required."
          : "The active task is progressing normally.",
        diagnosis: this.taskId
          ? "The task is queued behind a recoverable infrastructure fault."
          : "No real stall was found.",
        confidence: 0.99,
        actions: this.taskId
          ? [
              {
                type: "codex.repair",
                targetId: this.taskId,
                message:
                  "Repair the infrastructure and prove the original task can start.",
                reason: "The task cannot start without hands-on recovery.",
              },
            ]
          : [],
        verification: "Verify the original task prompt and running state.",
      },
    };
  }
}

class UnrestrictedRecoverySession {
  calls = [];

  constructor(onRun = null) {
    this.onRun = onRun;
  }

  async run(options) {
    this.calls.push(options);
    await this.onRun?.(options);
    options.onEvent?.({
      type: "thread.started",
      thread_id: "fresh-sol-recovery-thread",
    });
    options.onEvent?.({
      type: "item.started",
      item: {
        id: "repair-command",
        type: "command_execution",
        command: "powershell.exe -File Repair-And-Resume.ps1",
      },
    });
    return {
      threadId: "fresh-sol-recovery-thread",
      final: {
        status: "completed",
        summary: "The infrastructure is ready and the original task is queued.",
        diagnosis: "A recoverable test fault was repaired.",
        changedFiles: [],
        validation: ["Relay queue accepted the original task."],
        taskStartEvidence: ["The original task still has its queued turn."],
        risks: [],
      },
    };
  }
}

test("a started task Codex failure self-corrects without entering Ops repair", async (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-ops-test-"),
  );
  const config = configFor(dataDirectory);
  const store = new Store(config);
  const { project, worker } = seed(store);
  const adapter = new FakeAdapter(config);
  const scheduler = new Scheduler({ config, store, adapter });
  const session = new FakeOpsSession();
  const repairManager = {
    async run() {
      throw new Error("repair should not be needed");
    },
  };
  const ops = new OpsEngine(
    { config, store, scheduler, repairManager },
    { sessionRunner: session },
  );
  t.after(async () => {
    ops.stop();
    scheduler.stop();
    await scheduler.waitForIdle();
    store.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  store.createTask({
    projectId: project.id,
    title: "Recover me",
    message: "Run this turn [fake:fail=codex]",
    userName: "Tester",
  });
  await scheduler.start();
  await ops.start();

  await waitUntil(
    () =>
      store.listTaskTurns(store.listTasks()[0].id).at(-1)?.status ===
        "success" && store.getWorker(worker.id).status === "ready",
    "in-conversation task correction",
  );
  assert.deepEqual(store.listIncidents(), []);
  assert.deepEqual(store.listOpsActions(), []);
  assert.equal(session.calls.length, 0);
  const turns = store.listTaskTurns(store.listTasks()[0].id);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].errorCode, "CODEX_EXEC_FAILED");
  assert.equal(turns[1].authorName, "Relay Task Feedback");
  assert.equal(turns.at(-1).status, "success");
  assert.ok(
    store
      .listEvents({ limit: 250 })
      .some((event) => event.type === "turn.task-feedback"),
  );
});

test("manual System Codex messages resume the same durable Ops thread", async (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-ops-thread-test-"),
  );
  const config = configFor(dataDirectory);
  const store = new Store(config);
  seed(store);
  const scheduler = new Scheduler({
    config,
    store,
    adapter: new FakeAdapter(config),
  });
  const session = new FakeOpsSession();
  const ops = new OpsEngine(
    {
      config,
      store,
      scheduler,
      repairManager: { run: async () => null },
    },
    { sessionRunner: session },
  );
  t.after(async () => {
    ops.stop();
    scheduler.stop();
    store.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });
  await scheduler.start();
  await ops.start();
  ops.sendMessage("Inspect the entire Relay runtime", "Remote User");
  await waitUntil(
    () => store.listOpsTurns().at(-1)?.status === "completed",
    "first Ops turn",
  );
  ops.sendMessage("Continue and verify Guardian state", "Remote User");
  await waitUntil(
    () =>
      store.listOpsTurns().length === 2 &&
      store.listOpsTurns().every((turn) => turn.status === "completed"),
    "second Ops turn",
  );
  assert.equal(session.calls[0].threadId, null);
  assert.equal(session.calls[1].threadId, "ops-codex-thread");
  assert.deepEqual(
    store.listOpsTurns().map((turn) => turn.sequence),
    [1, 2],
  );
});

test("manual diagnosis stays read-only until the operator explicitly authorizes action", async (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-ops-manual-policy-test-"),
  );
  const config = configFor(dataDirectory);
  const store = new Store(config);
  const { project } = seed(store);
  const { task } = store.createTask({
    projectId: project.id,
    title: "Preserved task",
    message: "Original task request",
    userName: "Tester",
  });
  const scheduler = new Scheduler({
    config,
    store,
    adapter: new FakeAdapter(config),
  });
  const session = new ActionProposingOpsSession(task.id);
  const ops = new OpsEngine(
    {
      config,
      store,
      scheduler,
      repairManager: { run: async () => null },
    },
    { sessionRunner: session },
  );
  t.after(async () => {
    ops.stop();
    scheduler.stop();
    await scheduler.waitForIdle();
    store.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });
  await scheduler.start();
  await ops.start();

  ops.sendMessage(
    [
      "现场已保留",
      "error: Please commit your changes or stash them before checkout.",
      "HYPERV_COMMAND_FAILED 任务报错了",
    ].join("\n"),
    "Remote User",
  );
  await waitUntil(
    () => store.listOpsTurns().at(-1)?.status === "completed",
    "manual read-only diagnosis",
  );

  const diagnosticTurn = store.listOpsTurns().at(-1);
  assert.match(session.calls[0].prompt, /manual diagnosis-only turn/iu);
  assert.deepEqual(diagnosticTurn.final.actions, []);
  assert.equal(diagnosticTurn.final.actionResults[0].status, "suppressed");
  assert.equal(store.listOpsActions().length, 0);
  assert.equal(store.listTaskTurns(task.id).length, 1);
  const diagnosticEvents = store.listEvents({ limit: 250 });
  assert.ok(
    diagnosticEvents.some((event) => event.type === "ops.action.suppressed"),
  );
  assert.ok(
    diagnosticEvents.every(
      (event) => !event.message.includes("collab spawn failed"),
    ),
  );

  ops.sendMessage("请继续任务并安全恢复现场", "Remote User");
  await waitUntil(
    () =>
      store.listOpsTurns().length === 2 &&
      store.listOpsTurns().at(-1)?.status === "completed",
    "explicitly authorized manual action",
  );

  assert.match(session.calls[1].prompt, /authorized to execute/iu);
  assert.ok(
    store
      .listOpsActions()
      .some(
        (action) =>
          action.type === "task.continue" && action.status === "completed",
      ),
  );
  assert.ok(store.listTaskTurns(task.id).length >= 2);
});

test("multiple System Codex conversations run in parallel with independent settings and non-destructive clear", async (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-ops-parallel-test-"),
  );
  const config = configFor(dataDirectory);
  const store = new Store(config);
  seed(store);
  const scheduler = new Scheduler({
    config,
    store,
    adapter: new FakeAdapter(config),
  });
  const session = new ParallelOpsSession();
  const ops = new OpsEngine(
    {
      config,
      store,
      scheduler,
      repairManager: { run: async () => null },
    },
    { sessionRunner: session },
  );
  t.after(async () => {
    ops.stop();
    scheduler.stop();
    store.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });
  await scheduler.start();
  await ops.start();
  const first = store.createOpsThread({
    title: "Infrastructure",
    codexModel: "gpt-5.6-sol",
    codexReasoningEffort: "xhigh",
    codexFastMode: false,
  });
  const second = store.createOpsThread({
    title: "Web recovery",
    codexModel: "gpt-5.6-terra",
    codexReasoningEffort: "medium",
    codexFastMode: true,
  });

  ops.sendMessage("Inspect infrastructure", "Remote User", first.id);
  ops.sendMessage("Inspect the web", "Remote User", second.id);
  await waitUntil(
    () =>
      store.listOpsTurns().length === 2 &&
      store.listOpsTurns().every((turn) => turn.status === "completed"),
    "parallel Ops turns",
  );

  assert.equal(session.maxActive, 2);
  const callsByModel = new Map(session.calls.map((call) => [call.model, call]));
  assert.equal(callsByModel.get("gpt-5.6-sol").reasoningEffort, "xhigh");
  assert.equal(callsByModel.get("gpt-5.6-sol").fastMode, false);
  assert.equal(callsByModel.get("gpt-5.6-terra").reasoningEffort, "medium");
  assert.equal(callsByModel.get("gpt-5.6-terra").fastMode, true);
  assert.notEqual(
    store.getOpsThread(first.id).codexThreadId,
    store.getOpsThread(second.id).codexThreadId,
  );

  session.calls = [];
  session.maxActive = 0;
  ops.sendMessage("First serial follow-up", "Remote User", first.id);
  ops.sendMessage("Second serial follow-up", "Remote User", first.id);
  await waitUntil(
    () =>
      store.listOpsTurns({ threadId: first.id }).length === 3 &&
      store
        .listOpsTurns({ threadId: first.id })
        .every((turn) => turn.status === "completed"),
    "serial turns within one Ops conversation",
  );
  assert.equal(session.maxActive, 1);
  assert.ok(
    session.calls.every(
      (call) => call.threadId === store.getOpsThread(first.id).codexThreadId,
    ),
  );

  const codexThreadId = store.getOpsThread(first.id).codexThreadId;
  const cleared = store.clearOpsThread(first.id);
  assert.equal(cleared.clearedThroughSequence, 3);
  assert.equal(store.listOpsTurns({ threadId: first.id }).length, 0);
  assert.equal(
    store.listOpsTurns({ threadId: first.id, includeCleared: true }).length,
    3,
  );
  assert.equal(store.getOpsThread(first.id).codexThreadId, codexThreadId);
});

test("System Codex conversation API creates, configures, sends, and clears a thread", async (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-ops-api-test-"),
  );
  const config = configFor(dataDirectory);
  const store = new Store(config);
  seed(store);
  const scheduler = new Scheduler({
    config,
    store,
    adapter: new FakeAdapter(config),
  });
  const ops = new OpsEngine(
    {
      config,
      store,
      scheduler,
      repairManager: { run: async () => null },
    },
    { sessionRunner: new ParallelOpsSession() },
  );
  const api = new PipelineHttpServer({ config, store, scheduler, ops });
  const address = await api.listen();
  t.after(async () => {
    ops.stop();
    scheduler.stop();
    await api.close();
    store.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });
  await scheduler.start();
  await ops.start();
  const base = `http://127.0.0.1:${address.port}`;

  const createdResponse = await fetch(`${base}/api/ops/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "API conversation",
      codexModel: "gpt-5.6-terra",
      codexReasoningEffort: "high",
      codexFastMode: true,
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.thread.title, "API conversation");
  assert.equal(created.thread.codexFastMode, true);

  const updatedResponse = await fetch(
    `${base}/api/ops/threads/${created.thread.id}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codexReasoningEffort: "medium",
        codexFastMode: false,
      }),
    },
  );
  assert.equal(updatedResponse.status, 200);
  const updated = await updatedResponse.json();
  assert.equal(updated.thread.codexReasoningEffort, "medium");
  assert.equal(updated.thread.codexFastMode, false);

  const messageResponse = await fetch(`${base}/api/ops/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: created.thread.id,
      message: "Inspect this API conversation",
    }),
  });
  assert.equal(messageResponse.status, 201);
  await waitUntil(
    () =>
      store.listOpsTurns({ threadId: created.thread.id })[0]?.status ===
      "completed",
    "API Ops turn",
  );

  const clearResponse = await fetch(
    `${base}/api/ops/threads/${created.thread.id}/clear`,
    { method: "POST" },
  );
  assert.equal(clearResponse.status, 200);
  const cleared = await clearResponse.json();
  assert.equal(cleared.thread.clearedThroughSequence, 1);
  const opsResponse = await (await fetch(`${base}/api/ops`)).json();
  assert.ok(
    opsResponse.threads.some(
      (thread) =>
        thread.id === created.thread.id && thread.visibleTurnCount === 0,
    ),
  );
  assert.equal(
    opsResponse.turns.some((turn) => turn.threadId === created.thread.id),
    false,
  );
  assert.equal(
    store.listOpsTurns({
      threadId: created.thread.id,
      includeCleared: true,
    }).length,
    1,
  );
});

test("five-minute supervisor reuses Luna Max and spawns a fresh unrestricted Sol xhigh recovery conversation", async (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-persistent-supervisor-test-"),
  );
  const config = {
    ...configFor(dataDirectory),
    opsCodexModel: "gpt-5.6-luna",
    opsCodexReasoningEffort: "max",
  };
  const store = new Store(config);
  const { project } = seed(store);
  const originalPrompt =
    "Keep this exact user prompt, repair the system, and start my original task.";
  const { task } = store.createTask({
    projectId: project.id,
    title: "Prompt-preserved task",
    message: originalPrompt,
    userName: "Tester",
  });
  const scheduler = new Scheduler({
    config,
    store,
    adapter: new FakeAdapter(config),
  });
  const supervisor = new PersistentSupervisorSession(task.id);
  const recovery = new UnrestrictedRecoverySession();
  const ops = new OpsEngine(
    {
      config,
      store,
      scheduler,
      repairManager: { run: async () => null },
    },
    {
      sessionRunner: supervisor,
      recoverySessionRunner: recovery,
    },
  );
  t.after(async () => {
    ops.stop();
    await ops.waitForIdle();
    scheduler.stop();
    store.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  await ops.start();
  const monitorTurn = ops.runSupervisorCheck({ force: true });
  assert.equal(monitorTurn.trigger, "monitor");
  await waitUntil(
    () =>
      store
        .listOpsTurns({ includeCleared: true })
        .some(
          (turn) => turn.trigger === "repair" && turn.status === "completed",
        ),
    "unrestricted recovery conversation",
  );

  assert.equal(supervisor.calls[0].model, "gpt-5.6-luna");
  assert.equal(supervisor.calls[0].reasoningEffort, "max");
  assert.equal(supervisor.calls[0].sandbox, "read-only");
  assert.match(supervisor.calls[0].prompt, /five-minute supervisor/iu);
  assert.equal(recovery.calls[0].model, "gpt-5.6-sol");
  assert.equal(recovery.calls[0].reasoningEffort, "xhigh");
  assert.equal(recovery.calls[0].sandbox, "danger-full-access");
  assert.equal(recovery.calls[0].timeoutMs, 0);
  assert.match(recovery.calls[0].prompt, new RegExp(originalPrompt, "u"));

  const recoveryTurn = store
    .listOpsTurns({ includeCleared: true })
    .find((turn) => turn.trigger === "repair");
  assert.equal(recoveryTurn.targetTaskId, task.id);
  assert.equal(recoveryTurn.parentOpsTurnId, monitorTurn.id);
  assert.equal(
    store.getOpsThread(recoveryTurn.threadId).codexThreadId,
    "fresh-sol-recovery-thread",
  );
  assert.equal(
    store.getOpsThread(recoveryTurn.threadId).codexModel,
    "gpt-5.6-sol",
  );
  assert.equal(
    store.getOpsThread(recoveryTurn.threadId).codexReasoningEffort,
    "xhigh",
  );
  assert.equal(store.verifyTaskPromptIntegrity(task.id).intact, true);
  assert.equal(store.listTaskTurns(task.id)[0].userMessage, originalPrompt);
});

test("five-minute supervisor skips a stale repair after the target task finishes", (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-stale-supervisor-repair-test-"),
  );
  const config = configFor(dataDirectory);
  const store = new Store(config);
  const { project } = seed(store);
  const { task, turn } = store.createTask({
    projectId: project.id,
    title: "Task that finishes during supervisor diagnosis",
    message: "Finish before the stale repair action is dispatched.",
    userName: "Tester",
  });
  const scheduler = new Scheduler({
    config,
    store,
    adapter: new FakeAdapter(config),
  });
  const recovery = new UnrestrictedRecoverySession();
  const ops = new OpsEngine(
    {
      config,
      store,
      scheduler,
      repairManager: { run: async () => null },
    },
    { recoverySessionRunner: recovery },
  );
  t.after(() => {
    ops.stop();
    scheduler.stop();
    store.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  store.completeTurn(turn.id, {
    codexFinal: { status: "completed", summary: "Task finished." },
    commitSha: "b".repeat(40),
  });
  assert.equal(store.getTask(task.id).status, "waiting_user");
  store.ensureOpsThread();
  const monitorTurn = store.appendOpsTurn({
    threadId: "ops-system",
    message: "Stale monitor snapshot",
    trigger: "monitor",
    authorName: "Relay 5-minute Supervisor",
  });
  const result = ops.queueRecoveryConversation(
    monitorTurn,
    {
      type: "codex.repair",
      targetId: task.id,
      message: "Repair the stale task.",
      reason: "The old snapshot still showed it running.",
    },
    { diagnosis: "Stale task state." },
  );

  assert.deepEqual(result, {
    pending: false,
    skipped: true,
    targetTaskId: task.id,
    taskStatus: "waiting_user",
    reason: "target-left-supervised-state-before-action",
  });
  assert.equal(recovery.calls.length, 0);
  assert.equal(
    store
      .listOpsTurns({ includeCleared: true })
      .some((candidate) => candidate.trigger === "repair"),
    false,
  );
  assert.ok(
    store
      .listEvents({ limit: 100 })
      .some((event) => event.type === "ops.recovery.skipped"),
  );
});

test("queued recovery retires when the original first Codex turn is already running", async (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-stale-recovery-start-"),
  );
  const config = configFor(dataDirectory);
  const store = new Store(config);
  const { project } = seed(store);
  const { task, turn } = store.createTask({
    projectId: project.id,
    title: "Already working",
    message: "Do the task.",
    userName: "Tester",
  });
  const scheduler = new Scheduler({
    config,
    store,
    adapter: new FakeAdapter(config),
  });
  const recovery = new UnrestrictedRecoverySession();
  const ops = new OpsEngine(
    { config, store, scheduler, repairManager: { run: async () => null } },
    { recoverySessionRunner: recovery },
  );
  t.after(() => {
    ops.stop();
    scheduler.stop();
    store.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });
  store.ensureOpsThread();
  const parent = store.appendOpsTurn({
    threadId: "ops-system",
    message: "Old diagnosis",
    trigger: "monitor",
  });
  const queued = ops.queueRecoveryConversation(
    parent,
    { targetId: task.id, message: "Recover infrastructure" },
    {},
  );
  store.claimNextTurn();
  store.setTurnPhase(turn.id, "running");
  store.setTaskThread(task.id, "original-first-task-thread");
  await ops.executeRecoveryTurn(
    store
      .listOpsTurns({ includeCleared: true })
      .find((item) => item.id === queued.recoveryTurnId),
    new AbortController().signal,
  );
  assert.equal(recovery.calls.length, 0);
  assert.equal(store.listTaskTurns(task.id).length, 1);
  assert.equal(store.getTurn(turn.id).status, "running");
  assert.equal(
    store.getTask(task.id).codexThreadId,
    "original-first-task-thread",
  );
  const retired = store
    .listOpsTurns({ includeCleared: true })
    .find((item) => item.id === queued.recoveryTurnId);
  assert.equal(retired.status, "completed");
  assert.equal(
    retired.final.routing.reason,
    "original-task-conversation-active",
  );
  const again = ops.queueRecoveryConversation(
    parent,
    { targetId: task.id, message: "Stale duplicate" },
    {},
  );
  assert.equal(again.skipped, true);
});

test("a stale repair action for a post-Codex failure is rerouted to the original task conversation", async (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-ops-reroute-test-"),
  );
  const config = configFor(dataDirectory);
  const store = new Store(config);
  const { project, worker } = seed(store);
  const { task, turn } = store.createTask({
    projectId: project.id,
    title: "Post-Codex delivery failure",
    message: "Finish the original task.",
    userName: "Tester",
  });
  const scheduler = new Scheduler({
    config,
    store,
    adapter: new FakeAdapter(config),
  });
  const recovery = new UnrestrictedRecoverySession();
  const ops = new OpsEngine(
    {
      config,
      store,
      scheduler,
      repairManager: { run: async () => null },
    },
    { recoverySessionRunner: recovery },
  );
  t.after(() => {
    ops.stop();
    scheduler.stop();
    store.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  store.claimNextTurn();
  store.setTurnPhase(turn.id, "running");
  store.recordCodexCompletion(turn.id, {
    status: "completed",
    summary: "Task work completed before delivery failed.",
    changedFiles: ["Assets/Changed.cs"],
    validation: ["Validated"],
    risks: [],
  });
  store.failTurn(
    turn.id,
    Object.assign(new Error("Delivery audit needs task correction"), {
      code: "DELIVERY_AUDIT_TASK_CORRECTION_REQUIRED",
    }),
    { preserveWorker: true },
  );
  store.ensureOpsThread();
  const monitorTurn = store.appendOpsTurn({
    threadId: "ops-system",
    message: "Stale repair recommendation",
    trigger: "monitor",
    authorName: "Relay 5-minute Supervisor",
  });

  const result = ops.queueRecoveryConversation(
    monitorTurn,
    {
      type: "codex.repair",
      targetId: task.id,
      message: "Correct the delivery state.",
      reason: "The audit reported a task-level issue.",
    },
    {
      diagnosis: "Codex already completed the task turn.",
      verification: "Deliver the original task successfully.",
    },
  );

  assert.equal(result.rerouted, true);
  assert.equal(result.targetTaskId, task.id);
  assert.equal(recovery.calls.length, 0);
  const taskTurns = store.listTaskTurns(task.id);
  assert.equal(taskTurns.length, 2);
  assert.equal(taskTurns[1].authorName, "Relay Task Feedback");
  assert.equal(taskTurns[1].workerId, worker.id);
  const duplicate = await ops.performAction(
    monitorTurn,
    { type: "task.continue", targetId: task.id, message: "Continue again." },
    { diagnosis: "Repeated stale monitor result." },
  );
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.turnId, taskTurns[1].id);
  assert.equal(store.listTaskTurns(task.id).length, 2);
  store.failTurn(
    taskTurns[1].id,
    Object.assign(new Error("The automatic correction could not finish"), {
      code: "CODEX_BLOCKED",
    }),
    { preserveWorker: true },
  );
  const exhausted = await ops.performAction(
    monitorTurn,
    { type: "task.retry", targetId: task.id, message: "Retry again." },
    { diagnosis: "Repeated stale monitor result." },
  );
  assert.equal(exhausted.skipped, true);
  assert.equal(store.listTaskTurns(task.id).length, 2);
  assert.ok(
    store
      .listEvents({ limit: 100 })
      .some((event) => event.type === "ops.recovery.rerouted"),
  );
});

test("unrestricted recovery preserves its starting archive while allowing a concurrent append-only user turn", async (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-recovery-append-only-prompt-test-"),
  );
  const config = configFor(dataDirectory);
  const store = new Store(config);
  const { project } = seed(store);
  const { task } = store.createTask({
    projectId: project.id,
    title: "Append-only prompt task",
    message: "Preserve this original request exactly.",
    userName: "Original user",
  });
  const startingIntegrity = store.verifyTaskPromptIntegrity(task.id);
  const scheduler = new Scheduler({
    config,
    store,
    adapter: new FakeAdapter(config),
  });
  const supervisor = new PersistentSupervisorSession(task.id);
  const recovery = new UnrestrictedRecoverySession(() => {
    store.appendTurn(task.id, {
      message:
        "A concurrent user refinement must be appended, not mistaken for a rewrite.",
      userName: "Concurrent user",
    });
  });
  const ops = new OpsEngine(
    {
      config,
      store,
      scheduler,
      repairManager: { run: async () => null },
    },
    {
      sessionRunner: supervisor,
      recoverySessionRunner: recovery,
    },
  );
  t.after(async () => {
    ops.stop();
    await ops.waitForIdle();
    scheduler.stop();
    store.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  await ops.start();
  ops.runSupervisorCheck({ force: true });
  const recoveryTurn = await waitUntil(
    () =>
      store
        .listOpsTurns({ includeCleared: true })
        .find(
          (turn) => turn.trigger === "repair" && turn.status === "completed",
        ),
    "append-only recovery conversation",
  );

  const finalIntegrity = store.verifyTaskPromptIntegrity(task.id);
  assert.equal(finalIntegrity.intact, true);
  assert.equal(finalIntegrity.archivedTurns, 2);
  assert.equal(
    finalIntegrity.archive[0].userMessage,
    startingIntegrity.archive[0].userMessage,
  );
  assert.equal(
    finalIntegrity.archive[1].userMessage,
    "A concurrent user refinement must be appended, not mistaken for a rewrite.",
  );
  assert.notEqual(finalIntegrity.fingerprint, startingIntegrity.fingerprint);
  assert.equal(recoveryTurn.final.promptIntegrity.intact, true);
  assert.equal(
    recoveryTurn.final.promptIntegrity.startedFingerprint,
    startingIntegrity.fingerprint,
  );
  assert.equal(
    recoveryTurn.final.promptIntegrity.fingerprint,
    finalIntegrity.fingerprint,
  );
  assert.equal(recoveryTurn.final.promptIntegrity.addedArchivedTurns, 1);
});

test("task prompts are archived immutably before unrestricted recovery can run", (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-prompt-archive-test-"),
  );
  const config = configFor(dataDirectory);
  const store = new Store(config);
  const { project } = seed(store);
  t.after(() => {
    store.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  const { task, turn } = store.createTask({
    projectId: project.id,
    title: "Immutable original title",
    message: "Immutable original user request",
    userName: "Tester",
  });
  const archive = store.getTaskPromptArchive(task.id);
  assert.equal(archive.length, 1);
  assert.equal(archive[0].turnId, turn.id);
  assert.equal(archive[0].taskTitle, "Immutable original title");
  assert.equal(archive[0].userMessage, "Immutable original user request");
  assert.equal(store.verifyTaskPromptIntegrity(task.id).intact, true);

  assert.throws(
    () =>
      store.db
        .prepare("UPDATE turns SET user_message='changed' WHERE id=?")
        .run(turn.id),
    /TASK_PROMPT_IMMUTABLE/u,
  );
  assert.throws(
    () =>
      store.db
        .prepare("UPDATE tasks SET title='changed' WHERE id=?")
        .run(task.id),
    /TASK_PROMPT_IMMUTABLE/u,
  );
  assert.throws(
    () =>
      store.db
        .prepare("DELETE FROM task_prompt_archive WHERE turn_id=?")
        .run(turn.id),
    /TASK_PROMPT_ARCHIVE_IMMUTABLE/u,
  );
});

test("the persistent supervisor stays quiet without tasks and checks after the configured interval", async (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-supervisor-interval-test-"),
  );
  const config = {
    ...configFor(dataDirectory),
    opsSupervisorIntervalMs: 40,
  };
  const store = new Store(config);
  const { project } = seed(store);
  const scheduler = new Scheduler({
    config,
    store,
    adapter: new FakeAdapter(config),
  });
  const supervisor = new PersistentSupervisorSession();
  const ops = new OpsEngine(
    {
      config,
      store,
      scheduler,
      repairManager: { run: async () => null },
    },
    { sessionRunner: supervisor },
  );
  t.after(async () => {
    ops.stop();
    await ops.waitForIdle();
    scheduler.stop();
    store.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  await ops.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(supervisor.calls.length, 0);
  store.createTask({
    projectId: project.id,
    title: "Periodic check",
    message: "Watch this task every configured interval.",
    userName: "Tester",
  });
  await waitUntil(
    () => supervisor.calls.length >= 1,
    "scheduled persistent supervisor check",
  );
  const turn = store
    .listOpsTurns({ includeCleared: true })
    .find((candidate) => candidate.trigger === "monitor");
  assert.ok(turn);
  assert.match(turn.userMessage, /Five-minute persistent supervisor check/u);
});
