import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { Store } from "../../server/db.mjs";
import { OpsEngine } from "../../server/ops-engine.mjs";
import { Scheduler } from "../../server/scheduler.mjs";
import { FakeAdapter } from "./fake-adapter.mjs";

function configFor(dataDirectory, { opsAutoHandle = false } = {}) {
  return {
    version: "incident-idempotency-test",
    projectRoot: path.resolve("."),
    dataDirectory,
    databasePath: path.join(dataDirectory, "pipeline.sqlite"),
    uploadDirectory: path.join(dataDirectory, "uploads"),
    logDirectory: path.join(dataDirectory, "logs"),
    adapter: "test",
    schedulerIntervalMs: 60_000,
    healthIntervalMs: 60_000,
    phaseMs: 1,
    opsEnabled: true,
    opsAutoHandle,
    opsAutoDeploy: false,
    opsMaxAttempts: 4,
    opsMaxConcurrentSessions: 1,
    codexModel: "test-model",
    codexReasoningEffort: "high",
    codexServiceTier: "default",
    opsCodexModel: "test-model",
    opsCodexReasoningEffort: "high",
    opsCodexFastMode: false,
  };
}

function schedulerStub() {
  return {
    status: () => ({ running: false }),
    runtimeStatus: () => ({ ready: true }),
  };
}

function opsFor(config, store, scheduler = schedulerStub()) {
  return new OpsEngine(
    {
      config,
      store,
      scheduler,
      repairManager: { run: async () => null },
    },
    {
      sessionRunner: {
        async run() {
          return {
            threadId: "unused-test-thread",
            final: {
              status: "resolved",
              summary: "No recovery action was needed.",
              diagnosis: "Test-only session.",
              confidence: 1,
              actions: [],
              verification: "State remained durable.",
            },
          };
        },
      },
    },
  );
}

function insertGuardianFailure(
  store,
  eventId,
  message = "Guardian unavailable",
) {
  store.db
    .prepare(
      `
      INSERT INTO events (
        id, level, type, phase, message, data_json, created_at
      ) VALUES (?, 'error', 'guardian.health.failed', 'guardian', ?, ?, ?)
    `,
    )
    .run(
      eventId,
      message,
      JSON.stringify({ failures: 3 }),
      "2026-07-27T08:00:00.000Z",
    );
}

test("Guardian recovery remains authoritative when source event 3158 is replayed after scheduler restart", async (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-incident-restart-test-"),
  );
  const config = configFor(dataDirectory);
  const resources = [];
  t.after(async () => {
    for (const resource of resources.reverse()) {
      resource.ops?.stop();
      resource.scheduler?.stop();
      await resource.scheduler?.waitForIdle?.();
      if (!resource.closed) resource.store?.close();
    }
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  const firstStore = new Store(config);
  const firstScheduler = new Scheduler({
    config,
    store: firstStore,
    adapter: new FakeAdapter(config),
  });
  const firstOps = opsFor(config, firstStore, firstScheduler);
  const firstResource = {
    store: firstStore,
    scheduler: firstScheduler,
    ops: firstOps,
    closed: false,
  };
  resources.push(firstResource);
  await firstScheduler.start();
  insertGuardianFailure(firstStore, 3158);
  await firstOps.start();

  const captured = firstStore.getIncidentBySourceEventId(3158);
  assert.ok(captured);
  assert.equal(captured.resolvedAt, null);
  firstStore.emit({
    type: "guardian.health.recovered",
    phase: "guardian",
    message: "Relay Guardian is reachable again",
  });
  const recovered = firstStore.getIncident(captured.id);
  assert.equal(recovered.status, "resolved");
  assert.ok(recovered.resolvedAt);

  firstOps.stop();
  firstScheduler.stop();
  await firstScheduler.waitForIdle();
  firstStore.close();
  firstResource.closed = true;

  const restartedStore = new Store(config);
  const restartedScheduler = new Scheduler({
    config,
    store: restartedStore,
    adapter: new FakeAdapter(config),
  });
  const restartedOps = opsFor(config, restartedStore, restartedScheduler);
  resources.push({
    store: restartedStore,
    scheduler: restartedScheduler,
    ops: restartedOps,
    closed: false,
  });
  await restartedScheduler.start();
  await restartedOps.start();

  assert.equal(restartedStore.listIncidents().length, 1);
  assert.equal(restartedStore.getIncidentBySourceEventId(3158).id, captured.id);
  assert.equal(
    restartedStore.getIncidentBySourceEventId(3158).resolvedAt,
    recovered.resolvedAt,
  );
  assert.equal(restartedStore.listOpsTurns().length, 0);

  const newFailure = restartedStore.emit({
    type: "guardian.health.failed",
    phase: "guardian",
    level: "error",
    message: "Guardian failed a new health-check cycle",
    data: { failures: 3 },
  });
  const newIncident = restartedStore.getIncidentBySourceEventId(newFailure.id);
  assert.ok(newIncident);
  assert.notEqual(newIncident.id, captured.id);
  assert.equal(restartedStore.listIncidents().length, 2);
});

test("two capturers claim one source event and queue exactly one automatic recovery turn", (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-incident-concurrency-test-"),
  );
  const config = configFor(dataDirectory, { opsAutoHandle: true });
  const firstStore = new Store(config);
  const secondStore = new Store(config);
  t.after(() => {
    secondStore.close();
    firstStore.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });
  firstStore.ensureOpsThread();
  secondStore.ensureOpsThread();
  const firstOps = opsFor(config, firstStore);
  const secondOps = opsFor(config, secondStore);
  const event = {
    id: 7001,
    type: "guardian.health.failed",
    level: "error",
    taskId: null,
    turnId: null,
    workerId: null,
    message: "Both capturers observed the same Guardian failure",
    data: { failures: 3 },
    createdAt: "2026-07-27T08:30:00.000Z",
  };

  firstOps.recordProblem(event);
  secondOps.recordProblem(event);

  const incidents = firstStore.listIncidents();
  const turns = firstStore.listOpsTurns();
  const claim = firstStore.db
    .prepare(
      `
      SELECT * FROM incident_source_event_claims
      WHERE source_event_id=?
    `,
    )
    .get(String(event.id));
  assert.equal(incidents.length, 1);
  assert.equal(turns.length, 1);
  assert.equal(claim.incident_id, incidents[0].id);
  assert.equal(claim.auto_recovery_turn_id, turns[0].id);
  assert.equal(turns[0].incidentId, incidents[0].id);
});

test("migration preserves duplicate incidents and stably claims the earliest canonical row", (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-incident-migration-test-"),
  );
  const config = configFor(dataDirectory, { opsAutoHandle: true });
  fs.mkdirSync(dataDirectory, { recursive: true });
  const legacy = new DatabaseSync(config.databasePath);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE incidents (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      severity TEXT NOT NULL DEFAULT 'error',
      source_event_id INTEGER,
      task_id TEXT,
      turn_id TEXT,
      worker_id TEXT,
      title TEXT NOT NULL,
      error TEXT NOT NULL,
      context_json TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_action TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE TABLE ops_threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New conversation',
      is_system INTEGER NOT NULL DEFAULT 0,
      cleared_through_sequence INTEGER NOT NULL DEFAULT 0,
      codex_thread_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      codex_model TEXT NOT NULL DEFAULT 'test-model',
      codex_reasoning_effort TEXT NOT NULL DEFAULT 'high',
      codex_fast_mode INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE ops_turns (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES ops_threads(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      trigger TEXT NOT NULL DEFAULT 'manual',
      incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
      user_message TEXT NOT NULL,
      author_name TEXT NOT NULL DEFAULT 'Relay',
      status TEXT NOT NULL DEFAULT 'queued',
      final_json TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE(thread_id, sequence)
    );
  `);
  const insertIncident = legacy.prepare(`
    INSERT INTO incidents (
      id, fingerprint, status, severity, source_event_id, title, error,
      context_json, attempt_count, created_at, updated_at, resolved_at
    ) VALUES (?, ?, 'resolved', 'error', ?, ?, ?, ?, 1, ?, ?, ?)
  `);
  insertIncident.run(
    "incident-later",
    "guardian|later",
    3158,
    "Later duplicate",
    "later",
    JSON.stringify({ eventType: "guardian.health.failed" }),
    "2026-07-27T08:02:00.000Z",
    "2026-07-27T08:03:00.000Z",
    "2026-07-27T08:03:00.000Z",
  );
  insertIncident.run(
    "incident-earliest",
    "guardian|earliest",
    3158,
    "Earliest canonical",
    "earliest",
    JSON.stringify({ eventType: "guardian.health.failed" }),
    "2026-07-27T08:01:00.000Z",
    "2026-07-27T08:04:00.000Z",
    "2026-07-27T08:04:00.000Z",
  );
  insertIncident.run(
    "incident-other",
    "guardian|other",
    3159,
    "Other source event",
    "other",
    JSON.stringify({ eventType: "guardian.health.failed" }),
    "2026-07-27T08:05:00.000Z",
    "2026-07-27T08:06:00.000Z",
    "2026-07-27T08:06:00.000Z",
  );
  legacy
    .prepare(
      `
      INSERT INTO ops_threads (
        id, title, is_system, status, codex_model, codex_reasoning_effort,
        codex_fast_mode, created_at, updated_at
      ) VALUES (
        'ops-system', 'System recovery', 1, 'idle', 'test-model', 'high',
        0, '2026-07-27T08:00:00.000Z', '2026-07-27T08:00:00.000Z'
      )
    `,
    )
    .run();
  legacy
    .prepare(
      `
      INSERT INTO ops_turns (
        id, thread_id, sequence, trigger, incident_id, user_message,
        author_name, status, created_at, finished_at
      ) VALUES (
        'ops-turn-historical', 'ops-system', 1, 'incident',
        'incident-later', 'Historical automatic recovery',
        'Relay Auto Recovery', 'completed',
        '2026-07-27T08:02:30.000Z', '2026-07-27T08:02:40.000Z'
      )
    `,
    )
    .run();
  legacy.close();

  let store = new Store(config);
  t.after(() => {
    store?.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });
  assert.equal(store.listIncidents().length, 3);
  assert.equal(store.getIncidentBySourceEventId(3158).id, "incident-earliest");
  const firstClaim = store.db
    .prepare(
      `
      SELECT * FROM incident_source_event_claims
      WHERE source_event_id='3158'
    `,
    )
    .get();
  assert.equal(firstClaim.incident_id, "incident-earliest");
  assert.equal(firstClaim.auto_recovery_turn_id, "ops-turn-historical");
  assert.equal(
    store.db
      .prepare("SELECT COUNT(*) AS count FROM incident_source_event_claims")
      .get().count,
    2,
  );

  const replay = store.createIncident({
    fingerprint: "guardian|replayed",
    sourceEventId: 3158,
    title: "Replayed duplicate",
    error: "must not replace canonical history",
    context: { eventType: "guardian.health.failed" },
  });
  assert.equal(replay.created, false);
  assert.equal(replay.sourceEventClaimed, false);
  assert.equal(replay.incident.id, "incident-earliest");
  assert.equal(replay.incident.title, "Earliest canonical");
  assert.equal(store.listIncidents().length, 3);
  assert.equal(store.listOpsTurns({ includeCleared: true }).length, 1);

  store.close();
  store = new Store(config);
  assert.equal(store.listIncidents().length, 3);
  assert.equal(store.getIncidentBySourceEventId(3158).id, "incident-earliest");
  assert.equal(store.listOpsTurns({ includeCleared: true }).length, 1);
});
