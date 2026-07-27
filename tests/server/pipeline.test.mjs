import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FakeAdapter } from "./fake-adapter.mjs";
import { Store } from "../../server/db.mjs";
import { PipelineHttpServer } from "../../server/http.mjs";
import { Scheduler } from "../../server/scheduler.mjs";

function createConfig() {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-pipeline-test-"),
  );
  return {
    version: "test",
    dataDirectory,
    databasePath: path.join(dataDirectory, "pipeline.sqlite"),
    uploadDirectory: path.join(dataDirectory, "uploads"),
    logDirectory: path.join(dataDirectory, "logs"),
    adapter: "test",
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: [],
    requestBodyLimitBytes: 2 * 1024 * 1024,
    uploadLimitBytes: 25 * 1024 * 1024,
    schedulerIntervalMs: 5,
    healthIntervalMs: 60_000,
    phaseMs: 1,
    ozdqpBuildEnabled: true,
    ozdqpBuildRepositoryUrl: "http://git.dominogm.com/diaoyu/ozdqp.git",
  };
}

function seedProjectAndWorker(
  store,
  {
    workerStatus = "ready",
    repoUrl = "https://example.invalid/test-unity.git",
    autoBuildEnabled = false,
    buildProjectKey = null,
  } = {},
) {
  const project = store.createProject({
    id: "project-test",
    name: "Test Unity Project",
    repoUrl,
    defaultBranch: "main",
    guestProjectPath: "D:\\Work\\test-unity",
    smbPath: "\\\\172.30.240.11\\Work\\test-unity",
    unityVersion: "2022.3 LTS",
    unitySkillUrl: "http://{internalIp}:8090/mcp",
    unityHealthUrl: "http://{internalIp}:8090/health",
    unitySaveUrl: "http://{internalIp}:8090/api/save",
    checkpointName: "PROJECT_READY",
    autoBuildEnabled,
    buildProjectKey,
  });
  const worker = store.createWorker({
    id: "worker-test",
    name: "lin-worker-test",
    vmName: "lin-worker-test",
    projectId: project.id,
    checkpointName: "PROJECT_READY",
    internalIp: "172.30.240.11",
    sharePath: project.smbPath,
    status: workerStatus,
  });
  return { project, worker };
}

function createTask(store, projectId, options = {}) {
  return store.createTask({
    projectId,
    title: options.title || "Test task",
    message: options.message || "Perform the requested Unity change",
    priority: options.priority ?? 0,
    autoRelease: options.autoRelease ?? true,
    codexModel: options.codexModel,
    codexReasoningEffort: options.codexReasoningEffort,
    codexFastMode: options.codexFastMode,
    userName: options.userName,
  });
}

function createHarness(t, options = {}) {
  const config = createConfig();
  const store = new Store(config);
  const seeded = seedProjectAndWorker(store, options);
  const adapter = options.adapter || new FakeAdapter(config);
  const scheduler = new Scheduler({ config, store, adapter });
  t.after(async () => {
    scheduler.stop();
    await waitUntil(
      () => scheduler.controllers.size === 0 && scheduler.pumping === false,
      "scheduler cleanup",
    );
    await new Promise((resolve) => setImmediate(resolve));
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  });
  return { config, store, adapter, scheduler, ...seeded };
}

async function waitUntil(predicate, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (lastError) throw lastError;
  assert.fail(`Timed out waiting for ${description}`);
}

async function nextTimestamp() {
  await new Promise((resolve) => setTimeout(resolve, 3));
}

class TrackingFakeAdapter extends FakeAdapter {
  prepareCalls = 0;
  resumeCalls = 0;
  verifyCalls = 0;
  recoveryCalls = 0;
  releaseCalls = 0;
  controlCalls = [];
  codexContexts = [];

  async prepare(...args) {
    this.prepareCalls += 1;
    return super.prepare(...args);
  }

  async resumePreserved(...args) {
    this.resumeCalls += 1;
    return super.resumePreserved(...args);
  }

  async verifyPreserved(...args) {
    this.verifyCalls += 1;
    return super.verifyPreserved(...args);
  }

  async recoverPreserved(...args) {
    this.recoveryCalls += 1;
    return super.recoverPreserved(...args);
  }

  async runCodex(context, ...args) {
    this.codexContexts.push({
      branchName: context.task.branchName,
      codexThreadId: context.task.codexThreadId,
    });
    return super.runCodex(context, ...args);
  }

  async release(...args) {
    this.releaseCalls += 1;
    return super.release(...args);
  }

  async controlWorker(worker, action) {
    this.controlCalls.push(action);
    return super.controlWorker(worker, action);
  }
}

class RecoveryFailingFakeAdapter extends TrackingFakeAdapter {
  async recoverPreserved() {
    this.recoveryCalls += 1;
    throw Object.assign(
      new Error(
        "Preservation proof failed for baloot_client/Packages/manifest.json",
      ),
      { code: "WORKSPACE_PRESERVATION_UNPROVEN" },
    );
  }
}

class StartFailingFakeAdapter extends FakeAdapter {
  startCalls = 0;

  async controlWorker(worker, action) {
    if (action === "start") {
      this.startCalls += 1;
      throw Object.assign(new Error("Fake worker startup failed"), {
        code: "WORKER_START_FAILED",
      });
    }
    return super.controlWorker(worker, action);
  }
}

class WorkspaceRefusingFakeAdapter extends FakeAdapter {
  async prepare() {
    const details = {
      ready: false,
      code: "WORKSPACE_UNSAFE_CHANGES",
      blockedPaths: ["Assets/Removed.prefab", "secrets/signing.key"],
      deletionPaths: ["Assets/Removed.prefab"],
    };
    throw Object.assign(
      new Error(
        "Workspace checkout refused: Assets/Removed.prefab, secrets/signing.key",
      ),
      {
        code: details.code,
        blockedPaths: details.blockedPaths,
        details,
      },
    );
  }
}

test("priority/FIFO queue waits without a free worker, then dispatches in order", async (t) => {
  const { store, scheduler, project, worker } = createHarness(t, {
    workerStatus: "attention",
  });
  const deliveredTaskIds = [];
  store.onEvent((event) => {
    if (event.type === "turn.delivered") deliveredTaskIds.push(event.taskId);
  });

  scheduler.start();
  const lowFirst = createTask(store, project.id, {
    title: "Low first",
    message: "First low-priority task",
    priority: 1,
  });
  await nextTimestamp();
  const lowSecond = createTask(store, project.id, {
    title: "Low second",
    message: "Second low-priority task",
    priority: 1,
  });
  await nextTimestamp();
  const high = createTask(store, project.id, {
    title: "High priority",
    message: "High-priority task",
    priority: 9,
  });
  scheduler.notifyQueueChanged();

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(
    [lowFirst.turn, lowSecond.turn, high.turn].map(
      (turn) => store.getTurn(turn.id).status,
    ),
    ["queued", "queued", "queued"],
    "turns must remain queued while no worker is ready",
  );
  assert.deepEqual(
    store.snapshot().queue.map((turn) => turn.id),
    [high.turn.id, lowFirst.turn.id, lowSecond.turn.id],
    "queue view must sort by priority and then FIFO creation time",
  );

  store.setWorkerState(worker.id, "ready", {
    currentTurnId: null,
    error: null,
  });
  scheduler.notifyQueueChanged();
  await waitUntil(
    () =>
      [lowFirst.turn, lowSecond.turn, high.turn].every(
        (turn) => store.getTurn(turn.id).status === "success",
      ) &&
      store.getWorker(worker.id).status === "ready" &&
      scheduler.status().activeTurns === 0,
    "all queued turns to complete",
  );

  assert.deepEqual(deliveredTaskIds, [
    high.task.id,
    lowFirst.task.id,
    lowSecond.task.id,
  ]);
  assert.equal(store.getWorker(worker.id).status, "ready");
});

test("verified delivery writes the OZDQP outbox from task.branchName", async (t) => {
  const { store, scheduler, project, worker } = createHarness(t, {
    repoUrl: "http://git.dominogm.com/diaoyu/ozdqp.git",
    autoBuildEnabled: true,
    buildProjectKey: "ozdqp",
  });
  const created = createTask(store, project.id, {
    title: "OZDQP CDN delivery",
    message: "Deliver and queue the exact remote commit",
  });

  scheduler.start();
  scheduler.notifyQueueChanged();
  await waitUntil(
    () =>
      store.getTurn(created.turn.id).status === "success" &&
      store.getWorker(worker.id).status === "ready" &&
      scheduler.status().activeTurns === 0,
    "the verified delivery",
  );

  const dispatch = store.getBuildDispatchForTurn(created.turn.id);
  assert.equal(dispatch.status, "pending");
  assert.equal(dispatch.branchName, created.task.branchName);
  assert.notEqual(dispatch.branchName, created.task.baseBranch);
  assert.match(dispatch.commitSha, /^[0-9a-f]{40}$/u);
  assert.equal(
    dispatch.idempotencyKey,
    `relay:${created.turn.id}:${dispatch.commitSha}`,
  );
  assert.ok(
    store
      .listTaskEvents(created.task.id)
      .some((event) => event.type === "build.dispatch.queued"),
  );
});

test("push failure does not write the OZDQP outbox", async (t) => {
  const { store, scheduler, project, worker } = createHarness(t, {
    repoUrl: "http://git.dominogm.com/diaoyu/ozdqp.git",
    autoBuildEnabled: true,
    buildProjectKey: "ozdqp",
  });
  const created = createTask(store, project.id, {
    title: "Failed OZDQP delivery",
    message: "Simulate a push failure [fake:fail=push]",
  });

  scheduler.start();
  scheduler.notifyQueueChanged();
  await waitUntil(
    () =>
      store.getTurn(created.turn.id).status === "failed" &&
      store.getWorker(worker.id).status === "attention" &&
      scheduler.status().activeTurns === 0,
    "the failed remote push",
  );

  assert.equal(store.getBuildDispatchForTurn(created.turn.id), null);
  assert.equal(
    store
      .listTaskEvents(created.task.id)
      .some((event) => event.type === "build.dispatch.queued"),
    false,
  );
});

test("a queued turn automatically starts a stopped compatible worker", async (t) => {
  const { store, scheduler, project, worker } = createHarness(t, {
    workerStatus: "stopped",
  });
  const created = createTask(store, project.id, {
    title: "Wake a stopped worker",
    message: "Start the worker and execute this turn",
  });

  await scheduler.start();
  await waitUntil(
    () =>
      store.getTurn(created.turn.id).status === "success" &&
      store.getWorker(worker.id).status === "ready" &&
      scheduler.status().activeTurns === 0,
    "the stopped worker to start and execute the queued turn",
  );

  const events = store.listEvents({ limit: 500 });
  assert.ok(
    events.some(
      (event) =>
        event.workerId === worker.id &&
        event.type === "worker.action.started" &&
        event.data?.action === "start",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.workerId === worker.id &&
        event.type === "worker.action.completed" &&
        event.data?.action === "start",
    ),
  );
});

test("unsafe workspace preparation keeps attention and reports every blocked path", async (t) => {
  const adapter = new WorkspaceRefusingFakeAdapter({ phaseMs: 1 });
  const { store, scheduler, project, worker } = createHarness(t, { adapter });
  const created = createTask(store, project.id, {
    title: "Unsafe guest workspace",
    message: "Do not discard pre-existing guest changes",
  });

  scheduler.start();
  scheduler.notifyQueueChanged();
  await waitUntil(
    () =>
      store.getTurn(created.turn.id).status === "failed" &&
      store.getWorker(worker.id).status === "attention" &&
      scheduler.status().activeTurns === 0,
    "unsafe workspace refusal to preserve the worker",
  );

  const failedTurn = store.getTurn(created.turn.id);
  const preservedWorker = store.getWorker(worker.id);
  assert.equal(failedTurn.errorCode, "WORKSPACE_UNSAFE_CHANGES");
  assert.match(preservedWorker.lastError, /Assets\/Removed\.prefab/u);
  assert.match(preservedWorker.lastError, /secrets\/signing\.key/u);
  const failure = store
    .listTaskEvents(created.task.id)
    .find((event) => event.type === "turn.failed");
  assert.deepEqual(failure.data.blockedPaths, [
    "Assets/Removed.prefab",
    "secrets/signing.key",
  ]);
  assert.deepEqual(failure.data.workspaceRefusal.deletionPaths, [
    "Assets/Removed.prefab",
  ]);
  assert.equal(store.getTask(created.task.id).status, "failed");
  assert.equal(preservedWorker.currentTurnId, null);
});

test("a failed automatic worker start is surfaced once as attention", async (t) => {
  const adapter = new StartFailingFakeAdapter({ phaseMs: 1 });
  const { store, scheduler, project, worker } = createHarness(t, {
    workerStatus: "stopped",
    adapter,
  });
  const created = createTask(store, project.id, {
    title: "Failed automatic startup",
    message: "Do not spin forever when startup fails",
  });

  await scheduler.start();
  await waitUntil(
    () => store.getWorker(worker.id).status === "attention",
    "the startup failure to require attention",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(store.getTurn(created.turn.id).status, "queued");
  assert.equal(adapter.startCalls, 1);
  assert.match(
    store.getWorker(worker.id).lastError,
    /Fake worker startup failed/,
  );
  assert.ok(
    store
      .listEvents({ limit: 500 })
      .some(
        (event) =>
          event.workerId === worker.id &&
          event.type === "worker.action.failed" &&
          event.data?.action === "start",
      ),
  );
});

test("follow-up messages are always accepted and execute serially on the same thread and branch", async (t) => {
  const { store, scheduler, project } = createHarness(t);
  const created = createTask(store, project.id, {
    title: "Persistent conversation",
    message: "Create the first implementation",
  });
  scheduler.start();
  scheduler.notifyQueueChanged();
  await waitUntil(
    () =>
      store.getTurn(created.turn.id).status === "success" &&
      store.getWorker("worker-test").status === "ready" &&
      scheduler.status().activeTurns === 0,
    "the first turn to complete",
  );

  const afterFirst = store.getTask(created.task.id);
  assert.match(afterFirst.codexThreadId, /^test-thread-/);
  const originalThreadId = afterFirst.codexThreadId;
  const originalBranchName = afterFirst.branchName;

  scheduler.setPaused(true);
  const second = store.appendTurn(created.task.id, {
    message: "Fine-tune the same implementation",
  });
  const third = store.appendTurn(created.task.id, {
    message: "Queue one more adjustment",
  });

  assert.equal(store.getTask(created.task.id).codexThreadId, originalThreadId);
  assert.equal(store.getTask(created.task.id).branchName, originalBranchName);
  scheduler.setPaused(false);
  await waitUntil(
    () =>
      store.getTurn(second.id).status === "success" &&
      store.getTurn(third.id).status === "success" &&
      store.getWorker("worker-test").status === "ready" &&
      scheduler.status().activeTurns === 0,
    "the queued follow-up turns to complete",
  );

  const afterSecond = store.getTask(created.task.id);
  assert.equal(afterSecond.codexThreadId, originalThreadId);
  assert.equal(afterSecond.branchName, originalBranchName);
  assert.deepEqual(
    store.listTaskTurns(created.task.id).map((turn) => turn.sequence),
    [1, 2, 3],
  );
  assert.ok(
    store
      .listEvents({ limit: 500 })
      .some(
        (event) =>
          event.turnId === second.id &&
          event.type === "turn.codex" &&
          event.message.includes(
            `Resuming Codex conversation ${originalThreadId}`,
          ),
      ),
    "the second turn should explicitly resume the stored Codex conversation",
  );
});

test("messages queue during execution and automatically reopen a closed task", (t) => {
  const { store, project, worker } = createHarness(t);
  const created = createTask(store, project.id, {
    title: "Always accepting conversation",
    message: "Start the implementation",
  });
  const firstContext = store.claimNextTurn();
  assert.equal(firstContext.turn.id, created.turn.id);

  const queued = store.appendTurn(created.task.id, {
    message: "Add this while the first turn is still running",
  });
  assert.equal(store.getTurn(queued.id).status, "queued");
  assert.equal(store.getTask(created.task.id).status, "running");

  store.completeTurn(created.turn.id, {
    codexFinal: { status: "completed", summary: "First turn complete" },
    commitSha: "first-sha",
  });
  store.releaseWorkerAfterSuccess(worker.id);
  assert.equal(store.getTask(created.task.id).status, "queued");

  const secondContext = store.claimNextTurn();
  assert.equal(secondContext.turn.id, queued.id);
  store.completeTurn(queued.id, {
    codexFinal: { status: "completed", summary: "Queued turn complete" },
    commitSha: "second-sha",
  });
  store.releaseWorkerAfterSuccess(worker.id);
  store.closeTask(created.task.id);
  assert.equal(store.getTask(created.task.id).status, "closed");

  const reopened = store.appendTurn(created.task.id, {
    message: "Continue even though the task was closed",
  });
  assert.equal(reopened.status, "queued");
  assert.equal(store.getTask(created.task.id).status, "queued");
  assert.equal(store.getTask(created.task.id).closedAt, null);
});

test("Codex progress messages are stored as durable conversation events", async (t) => {
  const { store, scheduler, project } = createHarness(t);
  const created = createTask(store, project.id, {
    title: "Durable Codex progress",
    message: "Keep every user-facing Codex progress update",
  });
  scheduler.start();
  scheduler.notifyQueueChanged();

  await waitUntil(
    () =>
      store.getTurn(created.turn.id).status === "success" &&
      scheduler.status().activeTurns === 0,
    "the turn and its Codex progress to complete",
  );

  const messages = store
    .listTaskEvents(created.task.id)
    .filter((event) => event.type === "codex.agent_message");
  assert.deepEqual(
    messages.map((event) => event.message),
    [
      "I found the relevant Unity assets and am applying the requested changes.",
      "The changes are in place; I am running the final validation now.",
    ],
  );
  assert.ok(messages.every((event) => event.turnId === created.turn.id));
  assert.deepEqual(
    messages.map((event) => event.data?.itemType),
    ["agent_message", "agent_message"],
  );
});

test("a message after delivery failure resumes the preserved worker without preparing again", async (t) => {
  const config = createConfig();
  const adapter = new TrackingFakeAdapter(config);
  const store = new Store(config);
  const { project, worker } = seedProjectAndWorker(store);
  const scheduler = new Scheduler({ config, store, adapter });
  t.after(async () => {
    scheduler.stop();
    await waitUntil(
      () => scheduler.controllers.size === 0 && scheduler.pumping === false,
      "scheduler cleanup",
    );
    await new Promise((resolve) => setImmediate(resolve));
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  });

  const created = createTask(store, project.id, {
    title: "Push failure",
    message: "Change a prefab [fake:fail=push]",
  });
  scheduler.start();
  scheduler.notifyQueueChanged();
  await waitUntil(
    () =>
      store.getTurn(created.turn.id).status === "failed" &&
      store.getWorker(worker.id).status === "attention" &&
      scheduler.status().activeTurns === 0,
    "the simulated push failure",
  );

  const failedTurn = store.getTurn(created.turn.id);
  assert.equal(failedTurn.errorCode, "GIT_PUSH_FAILED");
  assert.equal(store.getTask(created.task.id).status, "failed");
  assert.equal(store.getWorker(worker.id).status, "attention");
  assert.equal(store.getWorker(worker.id).currentTurnId, null);
  assert.equal(adapter.releaseCalls, 0);
  assert.equal(adapter.prepareCalls, 1);
  assert.equal(
    store
      .listEvents({ limit: 500 })
      .some(
        (event) =>
          event.turnId === created.turn.id &&
          ["turn.release", "turn.released"].includes(event.type),
      ),
    false,
  );

  const continued = store.appendTurn(created.task.id, {
    message: "Continue after the Unity dialog was dismissed",
  });
  assert.equal(continued.workerId, worker.id);
  scheduler.notifyQueueChanged();
  await waitUntil(
    () =>
      store.getTurn(continued.id).status === "success" &&
      store.getWorker(worker.id).status === "ready" &&
      scheduler.status().activeTurns === 0,
    "the preserved workspace follow-up to complete",
  );
  assert.equal(adapter.prepareCalls, 1);
  assert.equal(adapter.resumeCalls, 1);
  assert.equal(adapter.verifyCalls, 1);
  assert.equal(adapter.recoveryCalls, 0);
  assert.equal(adapter.releaseCalls, 1);
  assert.ok(
    store
      .listTaskEvents(created.task.id)
      .some(
        (event) =>
          event.turnId === continued.id &&
          event.type === "turn.resume" &&
          event.message.includes(
            "without checkpoint restore, worker restart, or Git reset",
          ),
      ),
  );
});

test("clean task 17 recovery resumes its durable Codex thread without branch recovery", async (t) => {
  const config = createConfig();
  const adapter = new TrackingFakeAdapter(config);
  const store = new Store(config);
  const { project, worker } = seedProjectAndWorker(store);
  const scheduler = new Scheduler({ config, store, adapter });
  t.after(async () => {
    scheduler.stop();
    await waitUntil(
      () => scheduler.controllers.size === 0 && scheduler.pumping === false,
      "scheduler cleanup",
    );
    await new Promise((resolve) => setImmediate(resolve));
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  });

  const created = createTask(store, project.id, {
    title: "Task 17 preserved continuation",
    message: "Preserve this established workspace",
  });
  const threadId = "019fa356-ef1d-75b1-b402-dd4adc895039";
  const branchName = "codex/task-0017-task";
  store.db
    .prepare("UPDATE tasks SET task_number=17, branch_name=? WHERE id=?")
    .run(branchName, created.task.id);
  store.setTaskThread(created.task.id, threadId);
  const claimed = store.claimNextTurn();
  assert.equal(claimed.turn.id, created.turn.id);
  store.failTurn(
    created.turn.id,
    Object.assign(new Error("Keep the established task branch"), {
      code: "PRESERVED_FAILURE",
    }),
    { preserveWorker: true },
  );
  assert.equal(store.getWorker(worker.id).status, "attention");

  const continued = store.appendTurn(created.task.id, {
    message: "Continue the existing thread",
  });
  scheduler.start();
  scheduler.notifyQueueChanged();
  await waitUntil(
    () =>
      store.getTurn(continued.id).status === "success" &&
      scheduler.status().activeTurns === 0,
    "task 17 preserved continuation",
  );

  assert.equal(adapter.resumeCalls, 1);
  assert.equal(adapter.verifyCalls, 1);
  assert.equal(adapter.recoveryCalls, 0);
  assert.equal(adapter.prepareCalls, 0);
  assert.deepEqual(adapter.controlCalls, []);
  assert.deepEqual(adapter.codexContexts, [
    { branchName, codexThreadId: threadId },
  ]);
  assert.equal(store.getTask(created.task.id).branchName, branchName);
  assert.equal(store.getTask(created.task.id).codexThreadId, threadId);
  assert.ok(
    store
      .listTaskEvents(created.task.id)
      .some(
        (event) =>
          event.turnId === continued.id &&
          event.type === "turn.codex" &&
          event.message === `Resuming Codex conversation ${threadId}`,
      ),
  );
});

test("a pre-Codex prepare failure routes its attention worker through recovery, not verification", async (t) => {
  const config = createConfig();
  const adapter = new TrackingFakeAdapter(config);
  const store = new Store(config);
  const { project, worker } = seedProjectAndWorker(store);
  const scheduler = new Scheduler({ config, store, adapter });
  t.after(async () => {
    scheduler.stop();
    await waitUntil(
      () => scheduler.controllers.size === 0 && scheduler.pumping === false,
      "scheduler cleanup",
    );
    await new Promise((resolve) => setImmediate(resolve));
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  });

  const created = createTask(store, project.id, {
    title: "Prepare failed before task branch creation",
    message: "Initial preparation fails [fake:fail=prepare]",
  });
  scheduler.start();
  scheduler.notifyQueueChanged();
  await waitUntil(
    () =>
      store.getTurn(created.turn.id).status === "failed" &&
      store.getWorker(worker.id).status === "attention" &&
      scheduler.status().activeTurns === 0,
    "the initial preparation failure",
  );
  assert.equal(store.getTask(created.task.id).codexThreadId, null);
  assert.equal(
    store
      .listTaskEvents(created.task.id)
      .some((event) => event.type === "turn.workspace-established"),
    false,
  );

  const continued = store.appendTurn(created.task.id, {
    message: "Recover the preserved main workspace and continue",
  });
  scheduler.notifyQueueChanged();
  await waitUntil(
    () =>
      store.getTurn(continued.id).status === "success" &&
      scheduler.status().activeTurns === 0,
    "the non-destructive recovery continuation",
  );

  assert.equal(adapter.prepareCalls, 1);
  assert.equal(adapter.resumeCalls, 1);
  assert.equal(adapter.verifyCalls, 0);
  assert.equal(adapter.recoveryCalls, 1);
  assert.deepEqual(adapter.controlCalls, []);
  assert.ok(
    store
      .listTaskEvents(created.task.id)
      .some(
        (event) =>
          event.turnId === continued.id &&
          event.type === "turn.workspace-recovery",
      ),
  );
});

test("failed recovery keeps attention without checkpoint, reset, restart, or release", async (t) => {
  const config = createConfig();
  const adapter = new RecoveryFailingFakeAdapter(config);
  const store = new Store(config);
  const { project, worker } = seedProjectAndWorker(store);
  const scheduler = new Scheduler({ config, store, adapter });
  t.after(async () => {
    scheduler.stop();
    await waitUntil(
      () => scheduler.controllers.size === 0 && scheduler.pumping === false,
      "scheduler cleanup",
    );
    await new Promise((resolve) => setImmediate(resolve));
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  });

  const created = createTask(store, project.id, {
    title: "Recovery proof failure",
    message: "Initial preparation fails [fake:fail=prepare]",
  });
  scheduler.start();
  scheduler.notifyQueueChanged();
  await waitUntil(
    () =>
      store.getTurn(created.turn.id).status === "failed" &&
      store.getWorker(worker.id).status === "attention",
    "the initial preparation failure",
  );
  const continued = store.appendTurn(created.task.id, {
    message: "Attempt evidence-backed recovery",
  });
  scheduler.notifyQueueChanged();
  await waitUntil(
    () =>
      store.getTurn(continued.id).status === "failed" &&
      store.getWorker(worker.id).status === "attention" &&
      scheduler.status().activeTurns === 0,
    "the recovery proof failure",
  );

  assert.equal(
    store.getTurn(continued.id).errorCode,
    "WORKSPACE_PRESERVATION_UNPROVEN",
  );
  assert.equal(store.getWorker(worker.id).currentTurnId, null);
  assert.equal(adapter.verifyCalls, 0);
  assert.equal(adapter.recoveryCalls, 1);
  assert.equal(adapter.releaseCalls, 0);
  assert.deepEqual(adapter.controlCalls, []);
  const recoveryEvents = store
    .listTaskEvents(created.task.id)
    .filter((event) => event.turnId === continued.id);
  assert.equal(
    recoveryEvents.some((event) =>
      ["turn.restore", "turn.release", "turn.released"].includes(event.type),
    ),
    false,
  );
  assert.match(
    store.getWorker(worker.id).lastError,
    /baloot_client\/Packages\/manifest\.json/u,
  );
});

test("claiming preserved work atomically marks its attention worker busy", (t) => {
  const { store, project, worker } = createHarness(t);
  const created = createTask(store, project.id, {
    title: "Preserved atomic claim",
    message: "Fail after preparing the workspace",
  });
  const first = store.claimNextTurn();
  assert.equal(first.turn.id, created.turn.id);
  store.failTurn(
    created.turn.id,
    Object.assign(new Error("Preserve this workspace"), {
      code: "PRESERVED_FAILURE",
    }),
  );
  const continued = store.appendTurn(created.task.id, {
    message: "Continue on the preserved worker",
  });

  const resumed = store.claimNextTurn();
  assert.equal(resumed.turn.id, continued.id);
  assert.equal(resumed.resumePreservedWorkspace, true);
  assert.equal(resumed.worker.status, "busy");
  assert.equal(store.getWorker(worker.id).status, "busy");
  assert.equal(store.getWorker(worker.id).currentTurnId, continued.id);
});

test("autoRelease=false leaves a successful worker reserved", async (t) => {
  const config = createConfig();
  const adapter = new TrackingFakeAdapter(config);
  const store = new Store(config);
  const { project, worker } = seedProjectAndWorker(store);
  const scheduler = new Scheduler({ config, store, adapter });
  t.after(async () => {
    scheduler.stop();
    await waitUntil(
      () => scheduler.controllers.size === 0 && scheduler.pumping === false,
      "scheduler cleanup",
    );
    await new Promise((resolve) => setImmediate(resolve));
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  });

  const created = createTask(store, project.id, {
    title: "Reserved workspace",
    message: "Keep this workspace for manual inspection",
    autoRelease: false,
  });
  scheduler.start();
  scheduler.notifyQueueChanged();
  await waitUntil(
    () =>
      store.getWorker(worker.id).status === "reserved" &&
      scheduler.status().activeTurns === 0,
    "the worker to become reserved",
  );

  assert.equal(store.getTurn(created.turn.id).status, "success");
  assert.equal(store.getTask(created.task.id).status, "waiting_user");
  assert.equal(store.getWorker(worker.id).currentTurnId, null);
  assert.equal(adapter.releaseCalls, 0);
  assert.ok(
    store
      .listEvents({ limit: 500 })
      .some(
        (event) =>
          event.turnId === created.turn.id && event.type === "turn.reserved",
      ),
  );
});

test("pausing the scheduler preserves queued work and resuming dispatches it", async (t) => {
  const { store, scheduler, project, worker } = createHarness(t);
  scheduler.start();
  scheduler.setPaused(true);
  const created = createTask(store, project.id, {
    title: "Paused queue",
    message: "Wait until dispatch is resumed",
  });
  scheduler.notifyQueueChanged();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(store.getTurn(created.turn.id).status, "queued");
  assert.equal(store.getWorker(worker.id).status, "ready");

  scheduler.setPaused(false);
  await waitUntil(
    () =>
      store.getTurn(created.turn.id).status === "success" &&
      store.getWorker(worker.id).status === "ready" &&
      scheduler.status().activeTurns === 0,
    "paused work to dispatch after resume",
  );
});

test("SQLite restart preserves project URLs, task conversation, branch, and history", async (t) => {
  const config = createConfig();
  let store = new Store(config);
  const { project, worker } = seedProjectAndWorker(store);
  const created = createTask(store, project.id, {
    title: "Durable history",
    message: "Persist this completed turn",
    codexModel: "gpt-5.6-terra",
    codexReasoningEffort: "max",
    codexFastMode: true,
    userName: "持久化用户",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const context = store.claimNextTurn();
  assert.equal(context.turn.id, created.turn.id);
  store.setTurnPhase(created.turn.id, "running");
  store.setTaskThread(created.task.id, "thread-persisted-001");
  store.completeTurn(created.turn.id, {
    codexFinal: { status: "completed", summary: "Persisted result" },
    commitSha: "abc1234",
  });
  store.releaseWorkerAfterSuccess(worker.id);
  const originalBranchName = store.getTask(created.task.id).branchName;
  store.close();

  store = new Store(config);
  t.after(() => {
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  });
  const persistedProject = store.getProject(project.id);
  const persistedTask = store.getTask(created.task.id);
  const persistedTurn = store.getTurn(created.turn.id);

  assert.equal(
    persistedProject.unityHealthUrl,
    "http://{internalIp}:8090/health",
  );
  assert.equal(persistedProject.unitySkillUrl, "http://{internalIp}:8090/mcp");
  assert.equal(
    persistedProject.unitySaveUrl,
    "http://{internalIp}:8090/api/save",
  );
  assert.equal(persistedTask.codexThreadId, "thread-persisted-001");
  assert.equal(persistedTask.branchName, originalBranchName);
  assert.equal(persistedTask.latestCommitSha, "abc1234");
  assert.equal(persistedTask.status, "waiting_user");
  assert.equal(persistedTask.codexModel, "gpt-5.6-terra");
  assert.equal(persistedTask.codexReasoningEffort, "max");
  assert.equal(persistedTask.codexFastMode, true);
  assert.equal(persistedTask.createdBy, "持久化用户");
  assert.equal(persistedTurn.status, "success");
  assert.equal(persistedTurn.userMessage, "Persist this completed turn");
  assert.equal(persistedTurn.authorName, "持久化用户");
  assert.equal(persistedTurn.codexFinal.summary, "Persisted result");
  assert.equal(store.getWorker(worker.id).status, "ready");
  assert.equal(
    store.db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
});

test("browser preflight accepts the task idempotency header", async (t) => {
  const config = createConfig();
  const store = new Store(config);
  const { project } = seedProjectAndWorker(store);
  const scheduler = new Scheduler({
    config,
    store,
    adapter: new FakeAdapter(config),
  });
  const api = new PipelineHttpServer({ config, store, scheduler });
  const address = await api.listen();
  t.after(async () => {
    await api.close();
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${address.port}`;
  const origin = "http://localhost:3000";
  const servicePage = await fetch(`${base}/`);
  assert.equal(servicePage.status, 200);
  assert.match(servicePage.headers.get("content-type") || "", /text\/html/);
  assert.match(await servicePage.text(), /控制服务在线/);

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const preflight = await fetch(`${base}/api/tasks`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers":
        "content-type,idempotency-key,x-pipeline-user",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.match(
    preflight.headers.get("access-control-allow-headers") || "",
    /Idempotency-Key/i,
  );
  assert.match(
    preflight.headers.get("access-control-allow-headers") || "",
    /X-Pipeline-User/i,
  );

  const response = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": "browser-create-task-test",
      "X-Pipeline-User": encodeURIComponent("林"),
    },
    body: JSON.stringify({
      projectId: project.id,
      title: "Browser task",
      message: "Verify browser task creation",
      codexModel: "gpt-5.6-luna",
      codexReasoningEffort: "max",
      codexFastMode: true,
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  const firstPayload = await response.json();
  assert.equal(firstPayload.task.title, "Browser task");
  assert.equal(firstPayload.task.createdBy, "林");
  assert.equal(firstPayload.turn.authorName, "林");
  assert.equal(firstPayload.task.codexModel, "gpt-5.6-luna");
  assert.equal(firstPayload.task.codexReasoningEffort, "max");
  assert.equal(firstPayload.task.codexFastMode, true);

  const repeated = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": "browser-create-task-test",
    },
    body: JSON.stringify({
      projectId: project.id,
      title: "Browser task repeated by the transport",
      message: "This must resolve to the first request",
    }),
  });
  const repeatedPayload = await repeated.json();
  assert.equal(repeated.status, 201);
  assert.equal(repeatedPayload.task.id, firstPayload.task.id);
  assert.equal(repeatedPayload.turn.id, firstPayload.turn.id);
  assert.equal(repeatedPayload.duplicate, true);
  assert.equal(store.listTasks().length, 1);

  const followUp = await fetch(
    `${base}/api/tasks/${encodeURIComponent(firstPayload.task.id)}/messages`,
    {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Pipeline-User": encodeURIComponent("产品组小王"),
      },
      body: JSON.stringify({ message: "Add a second user's refinement" }),
    },
  );
  assert.equal(followUp.status, 201);
  const followUpPayload = await followUp.json();
  assert.equal(followUpPayload.turn.authorName, "产品组小王");
  assert.ok(
    store
      .listTaskEvents(firstPayload.task.id)
      .some(
        (event) =>
          event.type === "turn.queued" && event.actorName === "产品组小王",
      ),
  );

  const removedSessionRoute = await fetch(`${base}/api/session`, {
    method: "POST",
  });
  assert.equal(removedSessionRoute.status, 404);

  const invalidSettings = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": "browser-invalid-codex-settings",
    },
    body: JSON.stringify({
      projectId: project.id,
      title: "Invalid Codex settings",
      message: "This task must be rejected",
      codexModel: "gpt-5.6-luna",
      codexReasoningEffort: "ultra",
    }),
  });
  const invalidPayload = await invalidSettings.json();
  assert.equal(invalidSettings.status, 400);
  assert.equal(invalidPayload.error.code, "VALIDATION_ERROR");
  assert.equal(store.listTasks().length, 1);

  store.emit({
    taskId: firstPayload.task.id,
    turnId: firstPayload.turn.id,
    type: "codex.agent_message",
    phase: "codex",
    message: "This progress card must survive a task-detail reload.",
    data: { itemId: "http-progress-1", itemType: "agent_message" },
  });
  const detailResponse = await fetch(
    `${base}/api/tasks/${encodeURIComponent(firstPayload.task.id)}`,
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.ok(
    detail.events.some(
      (event) =>
        event.type === "codex.agent_message" &&
        event.message ===
          "This progress card must survive a task-detail reload.",
    ),
  );
});
