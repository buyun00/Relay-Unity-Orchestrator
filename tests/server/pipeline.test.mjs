import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FakeAdapter } from "./fake-adapter.mjs";
import { DailyAuditLogger } from "../../server/daily-audit-log.mjs";
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
  auditCalls = 0;
  deliveryRetryVerifyCalls = 0;
  finalizeCalls = 0;
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

  async auditDeliveryWorkspace(...args) {
    this.auditCalls += 1;
    return super.auditDeliveryWorkspace(...args);
  }

  async verifyDeliveryRetryWorkspace(...args) {
    this.deliveryRetryVerifyCalls += 1;
    return super.verifyDeliveryRetryWorkspace(...args);
  }

  async finalize(...args) {
    this.finalizeCalls += 1;
    return super.finalize(...args);
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

class PrerequisiteRecoveringFakeAdapter extends TrackingFakeAdapter {
  shouldFailResume = true;

  constructor(config, failureCode = "PRESERVED_WORKSPACE_NOT_READY") {
    super(config);
    this.failureCode = failureCode;
  }

  async resumePreserved(...args) {
    if (this.shouldFailResume) {
      this.shouldFailResume = false;
      this.resumeCalls += 1;
      throw Object.assign(new Error("Unity is unavailable after a crash"), {
        code: this.failureCode,
      });
    }
    return super.resumePreserved(...args);
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

class BlockedResultFakeAdapter extends TrackingFakeAdapter {
  shouldBlock = true;

  async runCodex(...args) {
    const result = await super.runCodex(...args);
    if (this.shouldBlock) {
      this.shouldBlock = false;
      result.final = {
        ...result.final,
        status: "blocked",
        summary: "Unity validation is blocked",
        risks: ["Workspace must remain preserved"],
      };
    }
    return result;
  }
}

class AlwaysBlockedResultFakeAdapter extends TrackingFakeAdapter {
  async runCodex(...args) {
    const result = await super.runCodex(...args);
    result.final = {
      ...result.final,
      status: "blocked",
      summary: "The task correction is still incomplete",
      risks: ["Keep the same workspace and conversation"],
    };
    return result;
  }
}

class InfrastructureNeedsInputFakeAdapter extends TrackingFakeAdapter {
  needsRecovery = true;

  async runCodex(...args) {
    const result = await super.runCodex(...args);
    if (this.needsRecovery) {
      this.needsRecovery = false;
      result.final = {
        ...result.final,
        status: "needs_input",
        summary: "UnitySkills did not recover after Play Mode",
        question:
          "Please restart this worker VM so UnitySkills 8090 can recover",
        risks: ["Unity Editor remains unavailable"],
      };
    }
    return result;
  }
}

class UserNeedsInputFakeAdapter extends TrackingFakeAdapter {
  async runCodex(...args) {
    const result = await super.runCodex(...args);
    result.final = {
      ...result.final,
      status: "needs_input",
      summary: "A product fixture is required",
      question: "Which account should be used for the paid reward scenario?",
      risks: ["The requested server state is not available"],
    };
    return result;
  }
}

class FailFirstDeliveryFakeAdapter extends TrackingFakeAdapter {
  shouldFailDelivery = true;

  async finalize(...args) {
    this.finalizeCalls += 1;
    if (this.shouldFailDelivery) {
      this.shouldFailDelivery = false;
      throw Object.assign(
        new Error("Transient Unity save infrastructure failure"),
        { code: "UNITY_SAVE_FAILED" },
      );
    }
    return FakeAdapter.prototype.finalize.apply(this, args);
  }
}

test("priority/FIFO queue waits without a free worker, then dispatches in order", async (t) => {
  const { store, scheduler, project, worker } = createHarness(t, {
    workerStatus: "reserved",
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

test("Skill and DialogGuard health never block a worker or queued turn", async (t) => {
  const { store, scheduler, project, worker, adapter } = createHarness(t, {
    workerStatus: "offline",
  });
  const unhealthyEvents = [];
  store.onEvent((event) => {
    if (event.type === "worker.unhealthy") unhealthyEvents.push(event);
  });
  adapter.probeWorker = async () => ({
    ready: true,
    vm: true,
    heartbeat: true,
    smb: true,
    unity: true,
    skill: false,
    dialogGuard: false,
    error: null,
    adapter: "test",
  });

  await scheduler.probeAll();

  assert.equal(store.getWorker(worker.id).status, "ready");
  assert.equal(unhealthyEvents.length, 0);

  const created = createTask(store, project.id, {
    title: "Auxiliary health is informational",
    message: "Run even when Skill and DialogGuard are unavailable",
  });
  scheduler.start();
  scheduler.notifyQueueChanged();

  await waitUntil(
    () => store.getTurn(created.turn.id).status === "success",
    "the turn to ignore auxiliary health",
  );
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

test("push failure is corrected in the task conversation and never dispatches the failed turn", async (t) => {
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
      store.getTask(created.task.id).status === "waiting_user" &&
      store.getWorker(worker.id).status === "ready" &&
      scheduler.status().activeTurns === 0,
    "the task conversation to correct the failed remote push",
  );

  assert.equal(store.getBuildDispatchForTurn(created.turn.id), null);
  const turns = store.listTaskTurns(created.task.id);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].errorCode, "GIT_PUSH_FAILED");
  assert.equal(turns[1].authorName, "Relay Task Feedback");
  assert.equal(turns[1].status, "success");
  assert.equal(
    store
      .listTaskEvents(created.task.id)
      .some(
        (event) =>
          event.turnId === created.turn.id &&
          event.type === "build.dispatch.queued",
      ),
    false,
  );
});

test("structured blocked result is sent back to the same task Codex conversation", async (t) => {
  const config = createConfig();
  const adapter = new BlockedResultFakeAdapter(config);
  const { store, scheduler, project, worker } = createHarness(t, { adapter });
  const created = createTask(store, project.id, {
    title: "Blocked Codex result",
    message: "Stop before delivery when Codex is blocked",
  });

  scheduler.start();
  scheduler.notifyQueueChanged();
  await waitUntil(
    () =>
      store.getTurn(created.turn.id).status === "failed" &&
      store.listTaskTurns(created.task.id).at(-1)?.status === "success" &&
      store.getWorker(worker.id).status === "ready" &&
      scheduler.status().activeTurns === 0,
    "the blocked result to be corrected in the task conversation",
  );

  const turn = store.getTurn(created.turn.id);
  const feedbackTurn = store.listTaskTurns(created.task.id).at(-1);
  assert.equal(turn.errorCode, "CODEX_BLOCKED");
  assert.equal(turn.codexFinal.status, "blocked");
  assert.equal(feedbackTurn.authorName, "Relay Task Feedback");
  assert.equal(feedbackTurn.status, "success");
  assert.match(
    feedbackTurn.userMessage,
    /Original summary: Unity validation is blocked/u,
  );
  assert.match(
    feedbackTurn.userMessage,
    /Original risks: Workspace must remain preserved/u,
  );
  assert.match(
    feedbackTurn.userMessage,
    /Never replace missing validation with a completed status/u,
  );
  assert.equal(adapter.codexContexts.length, 2);
  assert.equal(adapter.auditCalls, 1);
  assert.equal(adapter.finalizeCalls, 1);
  assert.equal(adapter.releaseCalls, 1);
  assert.equal(store.getBuildDispatchForTurn(created.turn.id), null);
  assert.ok(
    store
      .listTaskEvents(created.task.id)
      .some(
        (event) =>
          event.turnId === created.turn.id &&
          event.type === "turn.task-feedback",
      ),
  );
});

test("repeated blocked results stay in the original conversation before supervisor escalation", async (t) => {
  const config = createConfig();
  const adapter = new AlwaysBlockedResultFakeAdapter(config);
  const { store, scheduler, project, worker } = createHarness(t, { adapter });
  const created = createTask(store, project.id, {
    title: "Repeated task correction",
    message: "Keep correcting this task in the original conversation",
  });

  await scheduler.start();
  await waitUntil(
    () =>
      store.listTaskTurns(created.task.id).length === 4 &&
      store
        .listTaskTurns(created.task.id)
        .every((turn) => turn.status === "failed") &&
      scheduler.status().activeTurns === 0,
    "three direct corrections before supervisor escalation",
  );

  const turns = store.listTaskTurns(created.task.id);
  assert.deepEqual(
    turns.map((turn) => turn.authorName),
    [
      "未记录用户",
      "Relay Task Feedback",
      "Relay Task Feedback",
      "Relay Task Feedback",
    ],
  );
  assert.equal(store.getWorker(worker.id).status, "reserved");
  assert.equal(adapter.codexContexts.length, 4);
  const exhausted = store
    .listTaskEvents(created.task.id)
    .find((event) => event.type === "turn.task-feedback-exhausted");
  assert.equal(exhausted.level, "error");
  assert.equal(exhausted.data.priorFeedbackCount, 3);
});

test("infrastructure needs_input restarts the VM and resumes the same turn", async (t) => {
  const config = createConfig();
  const adapter = new InfrastructureNeedsInputFakeAdapter(config);
  const { store, scheduler, project, worker } = createHarness(t, { adapter });
  const created = createTask(store, project.id, {
    title: "Recover Unity after Codex detects infrastructure loss",
  });

  await scheduler.start();
  await waitUntil(
    () =>
      store.getTurn(created.turn.id).status === "success" &&
      scheduler.status().activeTurns === 0,
    "the same turn to complete after Codex-triggered VM recovery",
  );

  assert.equal(store.listTaskTurns(created.task.id).length, 1);
  assert.equal(adapter.codexContexts.length, 2);
  assert.deepEqual(adapter.controlCalls, ["restart"]);
  assert.equal(store.getWorker(worker.id).status, "ready");
  assert.ok(
    store
      .listTaskEvents(created.task.id)
      .some(
        (event) =>
          event.turnId === created.turn.id &&
          event.type === "turn.infrastructure-recovery.started" &&
          event.data.code === "CODEX_INFRASTRUCTURE_RECOVERY_REQUIRED",
      ),
  );
});

test("genuine needs_input waits on the task without creating a worker error", async (t) => {
  const config = createConfig();
  const adapter = new UserNeedsInputFakeAdapter(config);
  const { store, scheduler, project, worker } = createHarness(t, { adapter });
  const created = createTask(store, project.id, {
    title: "Wait for a real product decision",
  });

  await scheduler.start();
  await waitUntil(
    () =>
      store.getTurn(created.turn.id).status === "failed" &&
      scheduler.status().activeTurns === 0,
    "the task to wait for genuine user input",
  );

  assert.equal(store.getTurn(created.turn.id).errorCode, "CODEX_NEEDS_INPUT");
  assert.equal(store.getTask(created.task.id).status, "waiting_user");
  assert.equal(store.getWorker(worker.id).status, "reserved");
  assert.deepEqual(adapter.controlCalls, []);
});

test("durable queued turn leaves a disabled pinned worker for a ready worker", async (t) => {
  const { store, scheduler, project, worker } = createHarness(t);
  const disabled = store.createWorker({
    id: "worker-disabled-pinned",
    name: "lin-worker-disabled-pinned",
    vmName: "lin-worker-disabled-pinned",
    projectId: project.id,
    checkpointName: "PROJECT_READY",
    internalIp: "172.30.240.12",
    sharePath: project.smbPath,
    status: "reserved",
    enabled: false,
  });
  const created = createTask(store, project.id, {
    title: "Move durable work away from a disabled worker",
  });
  store.db
    .prepare(
      "UPDATE tasks SET codex_thread_id=?, latest_commit_sha=? WHERE id=?",
    )
    .run("thread-durable-disabled-worker", "a".repeat(40), created.task.id);
  store.db
    .prepare("UPDATE turns SET worker_id=? WHERE id=?")
    .run(disabled.id, created.turn.id);

  await scheduler.start();
  await waitUntil(
    () =>
      store.getTurn(created.turn.id).status === "success" &&
      scheduler.status().activeTurns === 0,
    "the durable turn to move to a ready worker",
  );

  assert.equal(store.getTurn(created.turn.id).workerId, worker.id);
  assert.ok(
    store
      .listTaskEvents(created.task.id)
      .some((event) => event.type === "turn.worker-reassigned"),
  );
});

test("queued turn without durable identity stays pinned to a disabled worker", (t) => {
  const { store, project } = createHarness(t, { workerStatus: "reserved" });
  const disabled = store.createWorker({
    id: "worker-disabled-unique-workspace",
    name: "lin-worker-disabled-unique-workspace",
    vmName: "lin-worker-disabled-unique-workspace",
    projectId: project.id,
    checkpointName: "PROJECT_READY",
    internalIp: "172.30.240.13",
    sharePath: project.smbPath,
    status: "reserved",
    enabled: false,
  });
  const created = createTask(store, project.id, {
    title: "Keep unique workspace pinned",
  });
  store.db
    .prepare("UPDATE turns SET worker_id=? WHERE id=?")
    .run(disabled.id, created.turn.id);

  assert.equal(store.claimNextTurn(), null);
  assert.equal(store.getTurn(created.turn.id).workerId, disabled.id);
  assert.equal(store.getTurn(created.turn.id).status, "queued");
});

test("delivery failure automatically resumes the original task Codex once", async (t) => {
  const config = createConfig();
  const adapter = new FailFirstDeliveryFakeAdapter(config);
  const { store, scheduler, project, worker } = createHarness(t, { adapter });
  const created = createTask(store, project.id, {
    title: "Delivery-only retry",
    message: "Codex finishes before a transient save failure",
  });

  scheduler.start();
  scheduler.notifyQueueChanged();
  await waitUntil(
    () =>
      store.getTurn(created.turn.id).status === "failed" &&
      store.listTaskTurns(created.task.id).at(-1)?.status === "success" &&
      store.getWorker(worker.id).status === "ready" &&
      scheduler.status().activeTurns === 0,
    "the original task conversation to recover the delivery failure",
  );

  const failed = store.getTurn(created.turn.id);
  const feedback = store.listTaskTurns(created.task.id).at(-1);
  assert.equal(failed.codexFinal.status, "completed");
  assert.equal(failed.deliveryAudit.safeForDeliveryRetry, true);
  assert.equal(feedback.authorName, "Relay Task Feedback");
  assert.equal(feedback.status, "success");
  assert.equal(adapter.codexContexts.length, 2);
  assert.equal(adapter.auditCalls, 2);
  assert.equal(adapter.deliveryRetryVerifyCalls, 0);
  assert.equal(adapter.finalizeCalls, 2);
  assert.ok(
    store
      .listTaskEvents(created.task.id)
      .some(
        (event) =>
          event.turnId === created.turn.id &&
          event.type === "turn.task-feedback",
      ),
  );
});

test("legacy completed turn uses matching final/JSONL evidence and immutable hashes without creating a continuation", async (t) => {
  const { config, store, scheduler, project, worker } = createHarness(t);
  const created = createTask(store, project.id, {
    title: "Legacy delivery retry evidence",
  });
  store.claimNextTurn();
  const threadId = "019fad77-3213-7513-b665-5daf2c007987";
  store.setTaskThread(created.task.id, threadId);
  store.setTurnPhase(created.turn.id, "running");
  store.failTurn(
    created.turn.id,
    Object.assign(new Error("Legacy Unity save failed"), {
      code: "HYPERV_COMMAND_FAILED",
    }),
    { preserveWorker: true },
  );

  const final = {
    status: "completed",
    summary: "Legacy Codex work completed",
    changedFiles: ["Assets/Only.cs"],
    validation: ["Recorded validation output"],
    risks: [],
  };
  const logDirectory = path.join(config.logDirectory, created.task.id);
  fs.mkdirSync(logDirectory, { recursive: true });
  const basename = `${created.turn.sequence}-${created.turn.id}`;
  fs.writeFileSync(
    path.join(logDirectory, `${basename}.final.json`),
    JSON.stringify(final),
  );
  fs.writeFileSync(
    path.join(logDirectory, `${basename}.jsonl`),
    [
      JSON.stringify({ type: "thread.started", thread_id: threadId }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify(final),
        },
      }),
      "",
    ].join("\n"),
  );
  config.legacyDeliveryRetryManifests = [
    {
      taskId: created.task.id,
      turnId: created.turn.id,
      threadId,
      workerName: worker.name,
      branch: created.task.branchName,
      head: "1".repeat(40),
      files: [
        {
          code: " M",
          path: "Assets/Only.cs",
          originalPath: null,
          gitBlob: "2".repeat(40),
          sha256: "3".repeat(64),
          unsafeReason: null,
        },
      ],
    },
  ];

  const retried = store.retryTask(created.task.id, "Operator");
  assert.equal(retried.id, created.turn.id);
  assert.equal(retried.executionMode, "delivery_only");
  assert.equal(retried.codexFinal.status, "completed");
  assert.equal(retried.deliveryAudit.safeForDeliveryRetry, true);
  assert.equal(store.listTaskTurns(created.task.id).length, 1);
  const event = store
    .listTaskEvents(created.task.id)
    .find((candidate) => candidate.type === "turn.delivery-retry.queued");
  assert.equal(event.data.protectedLegacyEvidence, true);
  scheduler.start();
  scheduler.notifyQueueChanged();
  await waitUntil(
    () =>
      store.getTurn(created.turn.id).status === "success" &&
      store.getWorker(worker.id).status === "ready" &&
      scheduler.status().activeTurns === 0,
    "the legacy delivery-only retry",
  );
});

test("delivery-only retry refuses altered recorded output without queuing or appending", (t) => {
  const { store, project, worker } = createHarness(t);
  const created = createTask(store, project.id, {
    title: "Unsafe delivery retry audit",
  });
  const claimed = store.claimNextTurn();
  store.setTurnPhase(claimed.turn.id, "running");
  const codexFinal = {
    status: "completed",
    summary: "Completed",
    changedFiles: ["Assets/Only.cs"],
    validation: ["Exact validation output"],
    risks: [],
  };
  const audit = {
    version: 1,
    safeForDeliveryRetry: true,
    completeFileSet: true,
    branch: created.task.branchName,
    head: "1".repeat(40),
    changedFiles: ["Assets/Only.cs"],
    validation: ["Different validation output"],
    files: [
      {
        code: " M",
        path: "Assets/Only.cs",
        originalPath: null,
        gitBlob: "2".repeat(40),
        sha256: "3".repeat(64),
        unsafeReason: null,
      },
    ],
    blockedPaths: [],
    fingerprint: "4".repeat(64),
  };
  store.recordCodexCompletion(created.turn.id, codexFinal);
  store.recordDeliveryAudit(created.turn.id, audit);
  store.failTurn(
    created.turn.id,
    Object.assign(new Error("Transient save failure"), {
      code: "UNITY_SAVE_FAILED",
    }),
    { preserveWorker: true },
  );

  assert.throws(
    () => store.retryTask(created.task.id, "Operator"),
    (error) => error.code === "DELIVERY_RETRY_AUDIT_UNSAFE",
  );
  assert.equal(store.getTurn(created.turn.id).status, "failed");
  assert.equal(store.getWorker(worker.id).status, "reserved");
  assert.deepEqual(
    store.listTaskTurns(created.task.id).map((turn) => turn.id),
    [created.turn.id],
  );
});

test("delivery-only retry rejects every unsafe recorded audit category before queuing", async (t) => {
  const cases = [
    {
      name: "branch",
      mutate: (audit) => {
        audit.branch = "codex/other-branch";
      },
    },
    {
      name: "complete file set",
      mutate: (audit) => {
        audit.changedFiles.push("Assets/Extra.cs");
      },
    },
    {
      name: "recorded validation",
      mutate: (audit) => {
        audit.validation = ["different validation"];
      },
    },
    {
      name: "untracked file",
      mutate: (audit) => {
        audit.files[0].code = "??";
        audit.files[0].unsafeReason = "untracked";
      },
    },
    {
      name: "deleted file",
      mutate: (audit) => {
        audit.files[0].code = " D";
        audit.files[0].unsafeReason = "deleted";
      },
    },
    {
      name: "renamed file",
      mutate: (audit) => {
        audit.files[0].code = " R";
        audit.files[0].originalPath = "Assets/Old.cs";
        audit.files[0].unsafeReason = "renamed-or-copied";
      },
    },
    {
      name: "extra file",
      mutate: (audit) => {
        audit.files.push({
          ...audit.files[0],
          path: "Assets/Extra.cs",
        });
      },
    },
    {
      name: "Git blob hash",
      mutate: (audit) => {
        audit.files[0].gitBlob = "not-a-hash";
      },
    },
    {
      name: "SHA-256 hash",
      mutate: (audit) => {
        audit.files[0].sha256 = "not-a-hash";
      },
    },
    {
      name: "blocked path",
      mutate: (audit) => {
        audit.blockedPaths = ["Assets/Only.cs"];
      },
    },
  ];

  for (const current of cases) {
    await t.test(current.name, (subtest) => {
      const { store, project, worker } = createHarness(subtest);
      const created = createTask(store, project.id, {
        title: `Reject ${current.name} mismatch`,
      });
      store.claimNextTurn();
      store.setTurnPhase(created.turn.id, "running");
      const codexFinal = {
        status: "completed",
        summary: "Completed",
        changedFiles: ["Assets/Only.cs"],
        validation: ["Exact validation"],
        risks: [],
      };
      const audit = {
        version: 1,
        safeForDeliveryRetry: true,
        completeFileSet: true,
        branch: created.task.branchName,
        head: "1".repeat(40),
        changedFiles: [...codexFinal.changedFiles],
        validation: [...codexFinal.validation],
        files: [
          {
            code: " M",
            path: "Assets/Only.cs",
            originalPath: null,
            gitBlob: "2".repeat(40),
            sha256: "3".repeat(64),
            unsafeReason: null,
          },
        ],
        blockedPaths: [],
        fingerprint: "4".repeat(64),
      };
      current.mutate(audit);
      store.recordCodexCompletion(created.turn.id, codexFinal);
      store.recordDeliveryAudit(created.turn.id, audit);
      store.failTurn(
        created.turn.id,
        Object.assign(new Error("Transient delivery failure"), {
          code: "UNITY_SAVE_FAILED",
        }),
        { preserveWorker: true },
      );

      assert.throws(
        () => store.retryTask(created.task.id, "Operator"),
        (error) => error.code === "DELIVERY_RETRY_AUDIT_UNSAFE",
      );
      assert.equal(store.getTurn(created.turn.id).status, "failed");
      assert.equal(store.getWorker(worker.id).status, "reserved");
      assert.equal(store.listTaskTurns(created.task.id).length, 1);
    });
  }
});

test("delivery-only retry rejects valid-looking HEAD and content-hash drift before finalize", async (t) => {
  for (const field of ["head", "hash"]) {
    await t.test(field, async (subtest) => {
      const config = createConfig();
      const adapter = new TrackingFakeAdapter(config);
      const { store, scheduler, project, worker } = createHarness(subtest, {
        adapter,
      });
      const created = createTask(store, project.id, {
        title: `Reject ${field} drift`,
      });
      const claimed = store.claimNextTurn();
      store.setTurnPhase(created.turn.id, "running");
      const codexFinal = {
        status: "completed",
        summary: "Completed before delivery retry",
        changedFiles: ["Assets/Only.cs"],
        validation: ["Validated"],
        risks: [],
      };
      store.recordCodexCompletion(created.turn.id, codexFinal);
      const audit = await adapter.auditDeliveryWorkspace(claimed, codexFinal);
      store.recordDeliveryAudit(created.turn.id, audit);
      store.failTurn(
        created.turn.id,
        Object.assign(new Error("Transient delivery failure"), {
          code: "UNITY_SAVE_FAILED",
        }),
        { preserveWorker: true },
      );
      if (field === "head") audit.head = "9".repeat(40);
      else audit.files[0].sha256 = "9".repeat(64);
      store.db
        .prepare("UPDATE turns SET delivery_audit_json=? WHERE id=?")
        .run(JSON.stringify(audit), created.turn.id);

      await scheduler.start({ paused: true });
      store.onEvent((event) => {
        if (event.type === "turn.task-feedback") scheduler.setPaused(true);
      });
      const retried = scheduler.retryTask(created.task.id, "Operator");
      assert.equal(retried.id, created.turn.id);
      scheduler.setPaused(false);
      await waitUntil(
        () =>
          store.getTurn(created.turn.id).status === "failed" &&
          store.listTaskTurns(created.task.id).length === 2 &&
          scheduler.status().activeTurns === 0,
        `the ${field} mismatch refusal`,
      );

      assert.equal(
        store.getTurn(created.turn.id).errorCode,
        "DELIVERY_RETRY_AUDIT_MISMATCH",
      );
      assert.equal(store.getWorker(worker.id).status, "reserved");
      assert.equal(adapter.codexContexts.length, 0);
      assert.equal(adapter.finalizeCalls, 0);
      assert.equal(
        store.listTaskTurns(created.task.id).at(-1).authorName,
        "Relay Task Feedback",
      );
    });
  }
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

test("unsafe workspace preparation reserves the workspace and reports every blocked path", async (t) => {
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
      store.getWorker(worker.id).status === "reserved" &&
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

test("a failed automatic worker start stays offline for infrastructure recovery", async (t) => {
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
    () => store.getWorker(worker.id).status === "offline",
    "the startup failure to stay in automatic recovery",
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

test("automatic task feedback resumes the preserved worker without preparing again", async (t) => {
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
      store.listTaskTurns(created.task.id).at(-1)?.status === "success" &&
      store.getWorker(worker.id).status === "ready" &&
      scheduler.status().activeTurns === 0,
    "the automatic preserved-workspace continuation",
  );

  const failedTurn = store.getTurn(created.turn.id);
  assert.equal(failedTurn.errorCode, "GIT_PUSH_FAILED");
  assert.equal(store.getTask(created.task.id).status, "waiting_user");
  assert.equal(store.getWorker(worker.id).status, "ready");
  assert.equal(store.getWorker(worker.id).currentTurnId, null);
  assert.equal(adapter.releaseCalls, 1);
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

  const continued = store.listTaskTurns(created.task.id).at(-1);
  assert.equal(continued.workerId, worker.id);
  assert.equal(continued.authorName, "Relay Task Feedback");
  assert.equal(continued.status, "success");
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

test("preserved automatic feedback runs before an older pinned retry without blocking other workers", (t) => {
  const { store, scheduler, project, worker } = createHarness(t);
  const current = createTask(store, project.id, {
    title: "Unpublished current task",
  });
  const context = store.claimNextTurn();
  assert.equal(context.turn.id, current.turn.id);

  const olderRetry = createTask(store, project.id, {
    title: "Older pinned retry",
    priority: 100,
  });
  store.assignNextQueuedTurn(olderRetry.task.id, worker.id);
  const feedback = scheduler.queueTaskFeedback(
    context,
    Object.assign(new Error("Runtime evidence unavailable"), {
      code: "CODEX_BLOCKED",
    }),
    { stage: "codex-result" },
  );
  assert.equal(feedback.workerId, worker.id);
  assert.equal(store.queuePosition(feedback.id), 1);
  assert.equal(store.queuePosition(olderRetry.turn.id), 2);

  const next = store.claimNextTurn();
  assert.equal(next.turn.id, feedback.id);
  assert.equal(next.worker.id, worker.id);
  assert.equal(next.resumePreservedWorkspace, true);
  assert.equal(store.getTurn(olderRetry.turn.id).status, "queued");

  const spare = store.createWorker({
    name: "spare-worker",
    vmName: "spare-worker",
    projectId: project.id,
    checkpointName: "PROJECT_READY",
    internalIp: "172.30.240.12",
    sharePath: "\\\\spare-worker\\Work\\test-unity",
    status: "ready",
  });
  const independent = createTask(store, project.id, {
    title: "Independent work",
  });
  const parallel = store.claimNextTurn();
  assert.equal(parallel.turn.id, independent.turn.id);
  assert.equal(parallel.worker.id, spare.id);
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
  assert.equal(store.getWorker(worker.id).status, "reserved");

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

test("a pre-Codex infrastructure failure restarts the VM and resumes the same turn", async (t) => {
  const config = createConfig();
  const adapter = new PrerequisiteRecoveringFakeAdapter(config);
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
    title: "Resume after Unity infrastructure recovery",
    message: "Establish the original task conversation",
  });
  const first = store.claimNextTurn();
  store.setTaskThread(created.task.id, "thread-infrastructure-recovery");
  store.failTurn(
    first.turn.id,
    Object.assign(new Error("Preserve the established workspace"), {
      code: "PRESERVED_FAILURE",
    }),
  );
  const continued = store.appendTurn(created.task.id, {
    message: "Continue the original turn after infrastructure recovery",
  });
  const turnCount = store.listTaskTurns(created.task.id).length;

  await scheduler.start();
  await waitUntil(
    () =>
      store.getTurn(continued.id).status === "success" &&
      scheduler.status().activeTurns === 0,
    "the same turn to resume after VM restart",
  );

  assert.equal(store.listTaskTurns(created.task.id).length, turnCount);
  assert.equal(adapter.resumeCalls, 2);
  assert.equal(adapter.verifyCalls, 1);
  assert.equal(adapter.recoveryCalls, 0);
  assert.deepEqual(adapter.controlCalls, ["restart"]);
  assert.equal(store.getWorker(worker.id).status, "ready");
  assert.ok(
    store
      .listTaskEvents(created.task.id)
      .some(
        (event) =>
          event.turnId === continued.id &&
          event.type === "turn.infrastructure-recovery.started",
      ),
  );
});

test("a pre-Codex task branch fetch timeout restarts the VM and resumes the same turn", async (t) => {
  const config = createConfig();
  const adapter = new PrerequisiteRecoveringFakeAdapter(
    config,
    "RECOVERY_FETCH_FAILED",
  );
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
    title: "Resume after task branch fetch recovery",
    message: "Establish the original task conversation",
  });
  const first = store.claimNextTurn();
  store.setTaskThread(created.task.id, "thread-fetch-recovery");
  store.failTurn(
    first.turn.id,
    Object.assign(new Error("Preserve the established workspace"), {
      code: "PRESERVED_FAILURE",
    }),
  );
  const continued = store.appendTurn(created.task.id, {
    message: "Continue the original turn after fetch recovery",
  });
  const turnCount = store.listTaskTurns(created.task.id).length;

  await scheduler.start();
  await waitUntil(
    () =>
      store.getTurn(continued.id).status === "success" &&
      scheduler.status().activeTurns === 0,
    "the same turn to resume after task branch fetch recovery",
  );

  assert.equal(store.listTaskTurns(created.task.id).length, turnCount);
  assert.equal(adapter.resumeCalls, 2);
  assert.equal(adapter.verifyCalls, 1);
  assert.equal(adapter.recoveryCalls, 0);
  assert.deepEqual(adapter.controlCalls, ["restart"]);
  assert.equal(store.getWorker(worker.id).status, "ready");
  assert.ok(
    store
      .listTaskEvents(created.task.id)
      .some(
        (event) =>
          event.turnId === continued.id &&
          event.type === "turn.infrastructure-recovery.started" &&
          event.data.code === "RECOVERY_FETCH_FAILED",
      ),
  );
});

test("failed workspace proof reserves the workspace without VM restart or release", async (t) => {
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
    message: "Preserve the initial workspace",
  });
  store.claimNextTurn();
  store.failTurn(
    created.turn.id,
    Object.assign(new Error("Initial preparation was interrupted"), {
      code: "PREPARE_INTERRUPTED",
    }),
  );
  const continued = store.appendTurn(created.task.id, {
    message: "Attempt evidence-backed recovery",
  });
  await scheduler.start();
  await waitUntil(
    () =>
      store.getTurn(continued.id).status === "failed" &&
      store.getWorker(worker.id).status === "reserved" &&
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

test("claiming preserved work atomically marks its reserved worker busy", (t) => {
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

test("an existing queued turn can rebind to its prior reserved worker without replacing the prompt", (t) => {
  const { store, project, worker } = createHarness(t);
  const created = createTask(store, project.id, {
    title: "Queued recovery rebind",
    message: "Preserve this original prompt",
  });
  const first = store.claimNextTurn();
  store.setTaskThread(created.task.id, "thread-preserved-rebind");
  store.completeTurn(first.turn.id, {
    codexFinal: {
      status: "completed",
      summary: "Committed before validation follow-up",
      changedFiles: [],
      validation: [],
      risks: [],
    },
    commitSha: "a".repeat(40),
  });
  store.setWorkerState(worker.id, "ready", {
    currentTurnId: null,
    error: null,
  });
  const continued = store.appendTurn(created.task.id, {
    message: "Run the queued validation on the same thread",
  });
  assert.equal(continued.workerId, null);
  const fingerprintBefore = store.taskPromptFingerprint(created.task.id);

  store.setWorkerState(worker.id, "reserved", {
    currentTurnId: null,
    error: "Infrastructure restarted while another turn was active",
  });
  const rebound = store.rebindQueuedTurnToPreservedWorker(
    created.task.id,
    "Recovery operator",
  );

  assert.equal(rebound.id, continued.id);
  assert.equal(rebound.workerId, worker.id);
  assert.equal(store.taskPromptFingerprint(created.task.id), fingerprintBefore);
  const resumed = store.claimNextTurn();
  assert.equal(resumed.turn.id, continued.id);
  assert.equal(resumed.resumePreservedWorkspace, true);
});

for (const refusalCode of [
  "WORKSPACE_BASE_BRANCH_MISMATCH",
  "RECOVERY_FETCH_FAILED",
  "WORKSPACE_RECOVERY_PROOF_MISMATCH",
]) {
  test(`a non-mutating pre-Codex ${refusalCode} refusal requeues the same archived turn behind current work`, (t) => {
    const { store, project, worker } = createHarness(t);
    const created = createTask(store, project.id, {
      title: "Same-turn workspace recovery",
      message: "Keep every archived prompt byte",
    });
    const first = store.claimNextTurn();
    store.setTaskThread(created.task.id, "thread-same-turn-recovery");
    store.completeTurn(first.turn.id, {
      codexFinal: {
        status: "completed",
        summary: "Committed before runtime validation",
        changedFiles: [],
        validation: [],
        risks: [],
      },
      commitSha: "b".repeat(40),
    });
    store.setWorkerState(worker.id, "ready", {
      currentTurnId: null,
      error: null,
    });
    const continued = store.appendTurn(created.task.id, {
      message: "Continue runtime validation in this exact turn",
    });
    const fingerprint = store.taskPromptFingerprint(created.task.id);
    store.setWorkerState(worker.id, "reserved", {
      currentTurnId: null,
      error: "Preserved after infrastructure recovery",
    });
    store.rebindQueuedTurnToPreservedWorker(
      created.task.id,
      "Recovery operator",
    );
    const claimed = store.claimNextTurn();
    assert.equal(claimed.turn.id, continued.id);
    store.failTurn(
      continued.id,
      Object.assign(
        new Error("Task branch fetch timed out before the workspace changed."),
        { code: refusalCode },
      ),
    );
    store.setWorkerState(worker.id, "ready", {
      currentTurnId: null,
      error: null,
    });
    const occupant = createTask(store, project.id, {
      title: "Current work after the VM restart",
      message: "Keep this unrelated current turn running.",
    });
    const occupyingContext = store.claimNextTurn();
    assert.equal(occupyingContext.turn.id, occupant.turn.id);
    assert.equal(store.getWorker(worker.id).status, "busy");

    const requeued = store.rebindQueuedTurnToPreservedWorker(
      created.task.id,
      "Recovery operator",
    );

    assert.equal(requeued.id, continued.id);
    assert.equal(requeued.status, "queued");
    assert.equal(requeued.workerId, worker.id);
    assert.equal(requeued.startedAt, null);
    assert.equal(requeued.finishedAt, null);
    assert.equal(requeued.errorCode, null);
    assert.equal(store.taskPromptFingerprint(created.task.id), fingerprint);
    assert.equal(store.listTaskTurns(created.task.id).length, 2);
    assert.equal(store.getWorker(worker.id).currentTurnId, occupant.turn.id);
    assert.equal(
      store
        .listTaskEvents(created.task.id)
        .some((event) => event.type === "turn.preserved-worker.requeued"),
      true,
    );
    assert.equal(store.claimNextTurn(), null);
    store.failTurn(
      occupant.turn.id,
      Object.assign(new Error("Finished unrelated current work"), {
        code: "PRESERVED_FAILURE",
      }),
    );
    const resumed = store.claimNextTurn();
    assert.equal(resumed.turn.id, continued.id);
    assert.equal(resumed.resumePreservedWorkspace, true);
  });
}

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

test("opening a second Store cannot recover live work until server startup", (t) => {
  const config = createConfig();
  const owner = new Store(config);
  const { project, worker } = seedProjectAndWorker(owner);
  const created = createTask(owner, project.id, {
    title: "Live turn",
    message: "Keep executing",
  });
  owner.claimNextTurn();
  owner.setTurnPhase(created.turn.id, "running");
  const auxiliary = new Store(config);
  t.after(() => {
    auxiliary.close();
    owner.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  });
  assert.equal(auxiliary.getTurn(created.turn.id).status, "running");
  assert.equal(owner.getTask(created.task.id).status, "running");
  assert.equal(owner.getWorker(worker.id).currentTurnId, created.turn.id);
  assert.equal(owner.getWorker(worker.id).status, "busy");
  // A real server startup explicitly requeues abandoned work for recovery.
  auxiliary.reconcileInterruptedWork();
  assert.equal(owner.getTurn(created.turn.id).status, "queued");
  assert.equal(owner.getTurn(created.turn.id).errorCode, null);
  assert.equal(owner.getTask(created.task.id).status, "queued");
  assert.equal(owner.getWorker(worker.id).status, "offline");
  const source = fs.readFileSync(path.resolve("server/index.mjs"), "utf8");
  assert.ok(
    source.indexOf("await api.listen();") <
      source.indexOf("store.reconcileInterruptedWork();"),
  );
  assert.ok(
    source.indexOf("store.reconcileInterruptedWork();") <
      source.indexOf("await scheduler.start("),
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
  const auditLog = new DailyAuditLogger({
    directory: path.join(config.logDirectory, "daily-audit"),
    timeZone: "UTC",
    rotationIntervalMs: 0,
  });
  const api = new PipelineHttpServer({
    config,
    store,
    scheduler,
    auditLog,
  });
  const address = await api.listen();
  t.after(async () => {
    await api.close();
    auditLog.close();
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

  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const uploadResponse = await fetch(`${base}/api/uploads`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "image/png",
      "X-File-Name": encodeURIComponent("参考图.png"),
      "X-Pipeline-User": encodeURIComponent("林"),
    },
    body: imageBytes,
  });
  assert.equal(uploadResponse.status, 201);
  const uploadPayload = await uploadResponse.json();
  assert.equal(uploadPayload.attachment.filename, "参考图.png");
  const notesBytes = Buffer.from("Original task attachment notes.\n", "utf8");
  const notesUploadResponse = await fetch(`${base}/api/uploads`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "text/plain",
      "X-File-Name": encodeURIComponent("说明 100%20.txt"),
      "X-Pipeline-User": encodeURIComponent("林"),
    },
    body: notesBytes,
  });
  assert.equal(notesUploadResponse.status, 201);
  const notesUploadPayload = await notesUploadResponse.json();
  assert.equal(notesUploadPayload.attachment.filename, "说明 100%20.txt");

  const response = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": "browser-create-task-test",
      "X-Pipeline-User": encodeURIComponent("林"),
      "CF-Connecting-IP": "203.0.113.45",
    },
    body: JSON.stringify({
      projectId: project.id,
      title: "Browser task",
      message: "Verify browser task creation",
      codexModel: "gpt-5.6-luna",
      codexReasoningEffort: "max",
      codexFastMode: true,
      executionProfile: "code_only",
      attachmentIds: [
        uploadPayload.attachment.id,
        notesUploadPayload.attachment.id,
      ],
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
  assert.equal(firstPayload.turn.executionProfile, "code_only");
  const taskDetailResponse = await fetch(
    `${base}/api/tasks/${encodeURIComponent(firstPayload.task.id)}`,
  );
  assert.equal(taskDetailResponse.status, 200);
  const taskDetailPayload = await taskDetailResponse.json();
  assert.equal(
    taskDetailPayload.turns[0].userMessage,
    "Verify browser task creation",
  );
  assert.equal(taskDetailPayload.turns[0].executionProfile, "code_only");
  assert.equal(taskDetailPayload.turns[0].attachments.length, 2);
  const detailImage = taskDetailPayload.turns[0].attachments.find(
    (attachment) => attachment.id === uploadPayload.attachment.id,
  );
  assert.deepEqual(detailImage, {
    id: uploadPayload.attachment.id,
    filename: "参考图.png",
    contentType: "image/png",
    size: imageBytes.length,
    createdAt: uploadPayload.attachment.createdAt,
  });
  const detailNotes = taskDetailPayload.turns[0].attachments.find(
    (attachment) => attachment.id === notesUploadPayload.attachment.id,
  );
  assert.deepEqual(detailNotes, {
    id: notesUploadPayload.attachment.id,
    filename: "说明 100%20.txt",
    contentType: "text/plain",
    size: notesBytes.length,
    createdAt: notesUploadPayload.attachment.createdAt,
  });
  assert.ok(
    taskDetailPayload.turns[0].attachments.every(
      (attachment) => !("path" in attachment),
    ),
  );

  const snapshotResponse = await fetch(`${base}/api/snapshot`);
  assert.equal(snapshotResponse.status, 200);
  const snapshotPayload = await snapshotResponse.json();
  const snapshotTurn = snapshotPayload.turns.find(
    (turn) => turn.id === firstPayload.turn.id,
  );
  assert.equal(snapshotTurn.userMessage, "Verify browser task creation");
  assert.deepEqual(
    snapshotTurn.attachments
      .map((attachment) => attachment.filename)
      .sort((left, right) => left.localeCompare(right)),
    ["参考图.png", "说明 100%20.txt"].sort((left, right) =>
      left.localeCompare(right),
    ),
  );

  const attachmentUrl = `${base}/api/attachments/${encodeURIComponent(uploadPayload.attachment.id)}`;
  const attachmentResponse = await fetch(attachmentUrl, {
    headers: { Origin: origin },
  });
  assert.equal(attachmentResponse.status, 200);
  assert.equal(attachmentResponse.headers.get("content-type"), "image/png");
  assert.match(
    attachmentResponse.headers.get("content-disposition") || "",
    /^inline;/u,
  );
  assert.match(
    attachmentResponse.headers.get("content-disposition") || "",
    /filename\*=UTF-8''/u,
  );
  assert.equal(
    attachmentResponse.headers.get("x-content-type-options"),
    "nosniff",
  );
  assert.equal(
    attachmentResponse.headers.get("access-control-allow-origin"),
    origin,
  );
  assert.deepEqual(
    Buffer.from(await attachmentResponse.arrayBuffer()),
    imageBytes,
  );

  const notesAttachmentUrl = `${base}/api/attachments/${encodeURIComponent(notesUploadPayload.attachment.id)}`;
  const notesAttachmentResponse = await fetch(notesAttachmentUrl);
  assert.equal(notesAttachmentResponse.status, 200);
  assert.equal(
    notesAttachmentResponse.headers.get("content-type"),
    "text/plain",
  );
  assert.match(
    notesAttachmentResponse.headers.get("content-disposition") || "",
    /^attachment;/u,
  );
  assert.match(
    notesAttachmentResponse.headers.get("content-disposition") || "",
    /%E8%AF%B4%E6%98%8E%20100%2520\.txt/u,
  );
  assert.deepEqual(
    Buffer.from(await notesAttachmentResponse.arrayBuffer()),
    notesBytes,
  );

  const attachmentHead = await fetch(attachmentUrl, { method: "HEAD" });
  assert.equal(attachmentHead.status, 200);
  assert.equal(
    Number(attachmentHead.headers.get("content-length")),
    imageBytes.length,
  );

  const missingAttachment = await fetch(`${base}/api/attachments/missing`);
  assert.equal(missingAttachment.status, 404);
  const accessEntries = fs
    .readFileSync(auditLog.currentFilePath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(
    accessEntries.some(
      (entry) =>
        entry.type === "access" &&
        entry.method === "POST" &&
        entry.path === "/api/tasks" &&
        entry.user === "林" &&
        entry.ip === "203.0.113.45" &&
        entry.statusCode === 201,
    ),
  );

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

  const followUpUploadResponse = await fetch(`${base}/api/uploads`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "image/png",
      "X-File-Name": encodeURIComponent("第二轮截图.png"),
    },
    body: imageBytes,
  });
  assert.equal(followUpUploadResponse.status, 201);
  const followUpUploadPayload = await followUpUploadResponse.json();

  const followUp = await fetch(
    `${base}/api/tasks/${encodeURIComponent(firstPayload.task.id)}/messages`,
    {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Pipeline-User": encodeURIComponent("产品组小王"),
      },
      body: JSON.stringify({
        message: "Add a second user's refinement",
        executionProfile: "unity_asset",
        attachmentIds: [followUpUploadPayload.attachment.id],
      }),
    },
  );
  assert.equal(followUp.status, 201);
  const followUpPayload = await followUp.json();
  assert.equal(followUpPayload.turn.authorName, "产品组小王");
  assert.equal(followUpPayload.turn.executionProfile, "unity_asset");
  const detailAfterFollowUp = await fetch(
    `${base}/api/tasks/${encodeURIComponent(firstPayload.task.id)}`,
  ).then((item) => item.json());
  const followUpDetail = detailAfterFollowUp.turns.find(
    (turn) => turn.id === followUpPayload.turn.id,
  );
  assert.equal(followUpDetail.attachments.length, 1);
  assert.equal(followUpDetail.attachments[0].filename, "第二轮截图.png");
  assert.ok(!("path" in followUpDetail.attachments[0]));
  assert.ok(
    store
      .listTaskEvents(firstPayload.task.id)
      .some(
        (event) =>
          event.type === "turn.queued" && event.actorName === "产品组小王",
      ),
  );

  const invalidExecutionProfile = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      title: "Invalid route",
      message: "Reject unknown route",
      executionProfile: "always_unity",
    }),
  });
  assert.equal(invalidExecutionProfile.status, 400);
  assert.equal(
    (await invalidExecutionProfile.json()).error.code,
    "INVALID_EXECUTION_PROFILE",
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
