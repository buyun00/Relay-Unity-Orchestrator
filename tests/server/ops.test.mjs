import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FakeAdapter } from "./fake-adapter.mjs";
import { Store } from "../../server/db.mjs";
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
    adapter: "test",
    schedulerIntervalMs: 5,
    healthIntervalMs: 60_000,
    phaseMs: 1,
    opsEnabled: true,
    opsAutoHandle: true,
    opsAutoDeploy: false,
    opsMaxAttempts: 4,
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
