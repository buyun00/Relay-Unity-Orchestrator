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
    codexModel: "test-model",
    codexReasoningEffort: "high",
    codexServiceTier: "default",
    opsCodexModel: "test-model",
    opsCodexReasoningEffort: "high",
    opsCodexFastMode: false,
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
        "ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit",
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

test("attention failures automatically enter the persistent Ops conversation and recover", async (t) => {
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
      store.listIncidents().some((incident) => incident.resolvedAt) &&
      store.getWorker(worker.id).status === "ready",
    "automatic incident recovery",
  );
  const incident = store.listIncidents()[0];
  assert.equal(incident.status, "resolved");
  assert.ok(incident.attemptCount >= 1);
  assert.equal(store.getOpsThread().codexThreadId, "ops-codex-thread");
  assert.ok(
    store
      .listOpsActions()
      .some(
        (action) =>
          action.type === "task.continue" && action.status === "completed",
      ),
  );
  assert.equal(
    store.listTaskTurns(store.listTasks()[0].id).at(-1).status,
    "success",
  );
  assert.ok(
    store
      .listEvents({ limit: 250 })
      .some((event) => event.type === "ops.incident.resolved"),
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
      (event) => !event.message.includes("failed to refresh available models"),
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
