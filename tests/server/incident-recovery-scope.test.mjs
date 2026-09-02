import assert from "node:assert/strict";
import test from "node:test";
import { OpsEngine } from "../../server/ops-engine.mjs";

test("checkpoint recovery events resolve only the matching worker incident", () => {
  const incidents = [
    {
      id: "incident-worker-01",
      status: "diagnosing",
      resolvedAt: null,
      taskId: null,
      workerId: "worker-01",
      context: { eventType: "checkpoint.maintenance.failed" },
    },
    {
      id: "incident-worker-02",
      status: "diagnosing",
      resolvedAt: null,
      taskId: null,
      workerId: "worker-02",
      context: { eventType: "checkpoint.maintenance.failed" },
    },
  ];
  const updates = [];
  const store = {
    listIncidents: () => incidents,
    updateIncident(id, patch) {
      const incident = incidents.find((candidate) => candidate.id === id);
      Object.assign(incident, patch);
      if (patch.resolved) incident.resolvedAt = "2026-08-22T00:00:00.000Z";
      updates.push(id);
      return incident;
    },
    emit() {},
  };
  const ops = new OpsEngine(
    {
      config: {},
      store,
      scheduler: {},
      repairManager: {},
    },
    {
      sessionRunner: {},
      recoverySessionRunner: {},
    },
  );

  ops.resolveMonitoredIncidents({
    type: "checkpoint.maintenance.completed",
    workerId: "worker-02",
    taskId: null,
  });

  assert.deepEqual(updates, ["incident-worker-02"]);
  assert.equal(incidents[0].resolvedAt, null);
  assert.equal(incidents[1].status, "resolved");
});

test("an unrelated task delivery on the same worker does not resolve a task incident", () => {
  const incidents = [
    {
      id: "incident-task-183",
      status: "monitoring",
      resolvedAt: null,
      taskId: "task-183",
      workerId: "worker-03",
      context: { eventType: "turn.failed" },
    },
  ];
  const updates = [];
  const store = {
    listIncidents: () => incidents,
    updateIncident(id, patch) {
      const incident = incidents.find((candidate) => candidate.id === id);
      Object.assign(incident, patch);
      if (patch.resolved) incident.resolvedAt = "2026-09-02T00:00:00.000Z";
      updates.push(id);
      return incident;
    },
    emit() {},
  };
  const ops = new OpsEngine(
    { config: {}, store, scheduler: {}, repairManager: {} },
    { sessionRunner: {}, recoverySessionRunner: {} },
  );

  ops.resolveMonitoredIncidents({
    type: "turn.delivered",
    taskId: "task-187",
    workerId: "worker-03",
  });
  assert.deepEqual(updates, []);
  assert.equal(incidents[0].resolvedAt, null);

  ops.resolveMonitoredIncidents({
    type: "turn.delivered",
    taskId: "task-183",
    workerId: "worker-03",
  });
  assert.deepEqual(updates, ["incident-task-183"]);
  assert.equal(incidents[0].status, "resolved");
});
