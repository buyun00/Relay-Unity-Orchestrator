import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CheckpointMaintenance,
  checkpointMaintenanceInternals,
} from "../../server/checkpoint-maintenance.mjs";
import { Store } from "../../server/db.mjs";
import { OpsEngine } from "../../server/ops-engine.mjs";
import { HyperVAdapter } from "../../server/adapters/hyperv.mjs";

function healthyWorker(overrides = {}) {
  return {
    id: "worker-maintenance",
    name: "lin-worker-01",
    vmName: "lin-worker-01",
    projectId: "project-maintenance",
    checkpointName: "PROJECT_READY",
    credentialPath: "C:\\ProgramData\\Relay\\secrets\\worker.json",
    enabled: true,
    status: "ready",
    currentTurnId: null,
    health: {
      vm: "healthy",
      heartbeat: "healthy",
      smb: "healthy",
      unity: "healthy",
    },
    ...overrides,
  };
}

function harness(
  t,
  {
    worker = healthyWorker(),
    adapter = null,
    taskWorkload = { queuedTurns: 0, executingTurns: 0, totalTurns: 0 },
    incidents = [],
  } = {},
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-checkpoint-maintenance-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let currentWorker = structuredClone(worker);
  const events = [];
  const project = {
    id: "project-maintenance",
    enabled: true,
    defaultBranch: "main",
    guestProjectPath: "D:\\ozdqp",
    repoUrl: "https://example.invalid/ozdqp.git",
    unitySaveUrl: "http://worker:8090/skill/editor_execute_menu",
  };
  const store = {
    listWorkers: () => [structuredClone(currentWorker)],
    getWorker: () => structuredClone(currentWorker),
    getProject: () => project,
    listIncidents: () => structuredClone(incidents),
    setWorkerState: (_id, status, changes = {}) => {
      currentWorker = {
        ...currentWorker,
        status,
        currentTurnId:
          changes.currentTurnId === undefined
            ? currentWorker.currentTurnId
            : changes.currentTurnId,
        lastError:
          changes.error === undefined ? currentWorker.lastError : changes.error,
      };
      return structuredClone(currentWorker);
    },
    updateWorkerHealth: (_id, health) => {
      currentWorker.health = {
        vm: health.vm ? "healthy" : "error",
        heartbeat: health.heartbeat ? "healthy" : "error",
        smb: health.smb ? "healthy" : "error",
        unity: health.unity ? "healthy" : "error",
      };
      return structuredClone(currentWorker);
    },
    getTaskWorkload: () => structuredClone(taskWorkload),
    reserveWorkerForCheckpointMaintenance: () => {
      if (taskWorkload.totalTurns > 0) {
        return {
          reserved: false,
          code: "CHECKPOINT_MAINTENANCE_TASK_QUEUE_NOT_EMPTY",
          workload: structuredClone(taskWorkload),
          worker: structuredClone(currentWorker),
        };
      }
      if (currentWorker.status !== "ready" || currentWorker.currentTurnId) {
        return {
          reserved: false,
          code: "CHECKPOINT_MAINTENANCE_WORKER_NOT_IDLE",
          workload: structuredClone(taskWorkload),
          worker: structuredClone(currentWorker),
        };
      }
      currentWorker = {
        ...currentWorker,
        status: "preparing",
        currentTurnId: null,
        lastError: null,
      };
      return {
        reserved: true,
        code: null,
        workload: structuredClone(taskWorkload),
        worker: structuredClone(currentWorker),
      };
    },
    emit: (event) => events.push(event),
  };
  const defaultAdapter = {
    refreshCalls: [],
    async refreshWorkerCheckpoint(selectedWorker, selectedProject, options) {
      this.refreshCalls.push({ selectedWorker, selectedProject, options });
      return {
        oldHead: "old-head",
        newHead: "new-head",
        checkpointName: "PROJECT_READY",
        checkpointId: "checkpoint-new",
        checkpoints: [
          { name: "PROJECT_READY", id: "checkpoint-new" },
          { name: "PROJECT_READY_PREV_20260803", id: "checkpoint-old" },
        ],
      };
    },
    async probeWorker() {
      return {
        ready: true,
        vm: true,
        heartbeat: true,
        smb: true,
        unity: true,
      };
    },
  };
  const config = {
    dataDirectory: directory,
    checkpointMaintenanceStatePath: path.join(directory, "state.json"),
    checkpointMaintenanceEnabled: true,
    checkpointsEnabled: true,
    checkpointMaintenanceHours: [5, 6, 7],
    checkpointMaintenanceTimeZone: "Asia/Shanghai",
    checkpointMaintenanceScanIntervalMs: 30_000,
    checkpointRetentionCount: 2,
  };
  return {
    config,
    store,
    events,
    adapter: adapter || defaultAdapter,
    worker: () => structuredClone(currentWorker),
  };
}

test("checkpoint maintenance schedules exact 05/06/07 local attempts", () => {
  const now = new Date("2026-08-03T20:59:30.000Z");
  const next = checkpointMaintenanceInternals.nextScheduledAttempt(
    now,
    "Asia/Shanghai",
    [5, 6, 7],
    { successDate: null, attemptedSlots: [] },
  );
  assert.equal(next.at, "2026-08-03T21:00:00.000Z");
  assert.equal(next.local, "2026-08-04 05:00");
});

test("a successful 05:00 refresh reserves the worker and suppresses later retries", async (t) => {
  const state = harness(t);
  let current = new Date("2026-08-03T21:05:00.000Z");
  const maintenance = new CheckpointMaintenance(
    {
      config: state.config,
      store: state.store,
      scheduler: {},
      adapter: state.adapter,
    },
    { now: () => current },
  );

  const result = await maintenance.tick();
  assert.equal(result.ok, true);
  assert.equal(state.adapter.refreshCalls.length, 1);
  assert.equal(state.adapter.refreshCalls[0].options.retentionCount, 2);
  assert.equal(state.worker().status, "ready");
  assert.ok(
    state.events.some(
      (event) => event.type === "checkpoint.maintenance.started",
    ),
  );
  assert.ok(
    state.events.some(
      (event) => event.type === "checkpoint.maintenance.completed",
    ),
  );

  current = new Date("2026-08-03T22:05:00.000Z");
  assert.equal(maintenance.tick(), null);
  assert.equal(state.adapter.refreshCalls.length, 1);
  assert.equal(maintenance.status().lastSuccessAt, "2026-08-03T21:05:00.000Z");
});

test("busy workers are untouched at 05/06 and become a Luna incident only after 07", async (t) => {
  const state = harness(t, {
    worker: healthyWorker({ status: "busy", currentTurnId: "turn-active" }),
  });
  let current = new Date("2026-08-03T21:05:00.000Z");
  const maintenance = new CheckpointMaintenance(
    {
      config: state.config,
      store: state.store,
      scheduler: {},
      adapter: state.adapter,
    },
    { now: () => current },
  );

  for (const hour of [21, 22, 23]) {
    current = new Date(`2026-08-03T${hour}:05:00.000Z`);
    const result = await maintenance.tick();
    assert.equal(result.ok, false);
  }

  assert.equal(state.adapter.refreshCalls.length, 0);
  assert.equal(state.worker().currentTurnId, "turn-active");
  assert.equal(
    state.events.filter(
      (event) => event.type === "checkpoint.maintenance.deferred",
    ).length,
    2,
  );
  const exhausted = state.events.find(
    (event) =>
      event.type === "checkpoint.maintenance.failed" &&
      event.data?.code === "CHECKPOINT_MAINTENANCE_WINDOW_EXHAUSTED",
  );
  assert.ok(exhausted);
});

test("queued or executing Relay turns defer maintenance before the worker is touched", async (t) => {
  for (const taskWorkload of [
    { queuedTurns: 1, executingTurns: 0, totalTurns: 1 },
    { queuedTurns: 0, executingTurns: 1, totalTurns: 1 },
    { queuedTurns: 2, executingTurns: 1, totalTurns: 3 },
  ]) {
    const state = harness(t, { taskWorkload });
    const maintenance = new CheckpointMaintenance(
      {
        config: state.config,
        store: state.store,
        scheduler: { notifyQueueChanged() {} },
        adapter: state.adapter,
      },
      { now: () => new Date("2026-08-03T21:05:00.000Z") },
    );

    const result = await maintenance.tick();
    assert.equal(result.ok, false);
    assert.equal(state.adapter.refreshCalls.length, 0);
    assert.equal(state.worker().status, "ready");
    assert.equal(
      result.results[0].code,
      "CHECKPOINT_MAINTENANCE_TASK_QUEUE_NOT_EMPTY",
    );
    assert.equal(result.results[0].queuedTurns, taskWorkload.queuedTurns);
    assert.equal(result.results[0].executingTurns, taskWorkload.executingTurns);
  }
});

test("the SQLite reservation atomically gives queued and executing turns priority", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-checkpoint-reservation-"),
  );
  const store = new Store({
    dataDirectory: directory,
    databasePath: path.join(directory, "pipeline.sqlite"),
    uploadDirectory: path.join(directory, "uploads"),
    logDirectory: path.join(directory, "logs"),
  });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const project = store.createProject({
    id: "project-maintenance-db",
    name: "Checkpoint Maintenance DB",
    repoUrl: "https://example.invalid/ozdqp.git",
    defaultBranch: "main",
    guestProjectPath: "D:\\ozdqp",
    smbPath: "\\\\worker\\d\\ozdqp",
    unityVersion: "2022.3 LTS",
    unitySkillUrl: "http://worker:8090/mcp",
    unityHealthUrl: "http://worker:8090/health",
    unitySaveUrl: "http://worker:8090/api/save",
    checkpointName: "PROJECT_READY",
  });
  const worker = store.createWorker({
    id: "worker-maintenance-db",
    name: "lin-worker-maintenance-db",
    vmName: "lin-worker-maintenance-db",
    projectId: project.id,
    checkpointName: "PROJECT_READY",
    internalIp: "172.30.240.11",
    sharePath: project.smbPath,
    status: "ready",
  });

  const idleReservation = store.reserveWorkerForCheckpointMaintenance(
    worker.id,
  );
  assert.equal(idleReservation.reserved, true);
  assert.equal(store.getWorker(worker.id).status, "preparing");
  store.setWorkerState(worker.id, "ready", { currentTurnId: null });

  store.createTask({
    projectId: project.id,
    title: "Queued user task",
    message: "This task must run before checkpoint maintenance",
    priority: 10,
    autoRelease: true,
  });
  const queuedReservation = store.reserveWorkerForCheckpointMaintenance(
    worker.id,
  );
  assert.equal(queuedReservation.reserved, false);
  assert.equal(
    queuedReservation.code,
    "CHECKPOINT_MAINTENANCE_TASK_QUEUE_NOT_EMPTY",
  );
  assert.deepEqual(queuedReservation.workload, {
    queuedTurns: 1,
    executingTurns: 0,
    totalTurns: 1,
  });
  assert.equal(store.getWorker(worker.id).status, "ready");

  const claimed = store.claimNextTurn();
  assert.ok(claimed);
  const executingReservation = store.reserveWorkerForCheckpointMaintenance(
    worker.id,
  );
  assert.equal(executingReservation.reserved, false);
  assert.deepEqual(executingReservation.workload, {
    queuedTurns: 0,
    executingTurns: 1,
    totalTurns: 1,
  });
  assert.equal(store.getWorker(worker.id).status, "busy");
});

test("refresh failures emit a worker incident but return a healthy rollback worker to ready", async (t) => {
  const adapter = {
    refreshCalls: [],
    async refreshWorkerCheckpoint() {
      this.refreshCalls.push(true);
      throw Object.assign(new Error("UnitySkills canary failed"), {
        code: "UNITYSKILLS_CANARY_FAILED",
      });
    },
    async probeWorker() {
      return {
        ready: true,
        vm: true,
        heartbeat: true,
        smb: true,
        unity: true,
      };
    },
  };
  const state = harness(t, { adapter });
  const current = new Date("2026-08-03T21:05:00.000Z");
  const maintenance = new CheckpointMaintenance(
    {
      config: state.config,
      store: state.store,
      scheduler: {},
      adapter,
    },
    { now: () => current },
  );

  const result = await maintenance.tick();
  assert.equal(result.ok, false);
  assert.equal(state.worker().status, "ready");
  const failure = state.events.find(
    (event) => event.type === "checkpoint.maintenance.failed",
  );
  assert.equal(failure.level, "error");
  assert.equal(failure.data.code, "UNITYSKILLS_CANARY_FAILED");
});

test("an unresolved checkpoint incident keeps maintenance closed without touching the worker", async (t) => {
  const incident = {
    id: "incident-checkpoint-dirty",
    workerId: "worker-maintenance",
    resolvedAt: null,
    context: { eventType: "checkpoint.maintenance.failed" },
  };
  const state = harness(t, { incidents: [incident] });
  const maintenance = new CheckpointMaintenance(
    {
      config: state.config,
      store: state.store,
      scheduler: { notifyQueueChanged() {} },
      adapter: state.adapter,
    },
    { now: () => new Date("2026-08-03T22:05:00.000Z") },
  );

  const result = await maintenance.tick();
  assert.equal(result.ok, false);
  assert.equal(state.adapter.refreshCalls.length, 0);
  assert.equal(state.worker().status, "ready");
  assert.equal(
    result.results[0].code,
    "CHECKPOINT_MAINTENANCE_INCIDENT_OPEN",
  );
  assert.equal(result.results[0].incidentId, incident.id);
  assert.equal(
    state.events.some(
      (event) => event.type === "checkpoint.maintenance.started",
    ),
    false,
  );
});

test("structured checkpoint attention survives the PowerShell transport and maintenance event", async (t) => {
  const checkpointFailure = {
    code: "CHECKPOINT_WORKSPACE_DIRTY",
    message:
      "Unity refresh changed non-approved tracked files: one.meta, two.meta",
    checkpointName: "PROJECT_READY",
    previousCheckpointRetained: true,
    checkpointDirty: {
      paths: ["one.meta", "two.meta"],
      entries: [
        { path: "one.meta", headBlob: "a", worktreeBlob: "b" },
        { path: "two.meta", headBlob: "c", worktreeBlob: "d" },
      ],
    },
  };
  const hyperv = new HyperVAdapter(
    { powershellCommand: "powershell.exe" },
    {
      processRunner: async () => {
        throw Object.assign(new Error("truncated tail"), {
          code: "PROCESS_FAILED",
          exitCode: 1,
          stdout: JSON.stringify(checkpointFailure),
          stderr: "formatted PowerShell error",
        });
      },
      codex: {},
    },
  );
  const adapter = {
    async refreshWorkerCheckpoint() {
      return hyperv.powershell("Update-ProjectReadyCheckpoint.ps1", {});
    },
    async probeWorker() {
      return {
        ready: true,
        vm: true,
        heartbeat: true,
        smb: true,
        unity: true,
      };
    },
  };
  const state = harness(t, { adapter });
  const maintenance = new CheckpointMaintenance(
    {
      config: state.config,
      store: state.store,
      scheduler: {},
      adapter,
    },
    { now: () => new Date("2026-08-03T21:05:00.000Z") },
  );

  const result = await maintenance.tick();
  assert.equal(result.ok, false);
  assert.equal(state.worker().status, "ready");
  const failure = state.events.find(
    (event) => event.type === "checkpoint.maintenance.failed",
  );
  assert.equal(failure.data.code, "CHECKPOINT_WORKSPACE_DIRTY");
  assert.deepEqual(failure.data.attention, checkpointFailure);
});

test("the Hyper-V refresh script is fast-forward-only and prunes after canary", () => {
  const source = fs.readFileSync(
    new URL(
      "../../scripts/hyperv/Update-ProjectReadyCheckpoint.ps1",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /merge', '--ff-only'/u);
  assert.match(source, /if \(\$oldHead -eq \$newHead\)/u);
  assert.match(source, /'fast-forward-skipped'/u);
  assert.match(source, /reason = 'already-current'/u);
  assert.match(source, /if \(\$oldBlob -eq \$newBlob\)/u);
  assert.match(source, /baseChanged = \$false[\s\S]*?continue/u);
  assert.match(
    source,
    /\$currentVm\.ParentCheckpointId -ne \$activeCheckpoint\.Id/u,
  );
  assert.match(source, /'initial-restore-skipped'/u);
  assert.match(
    source,
    /function Write-CheckpointProgress[\s\S]*?\$activeCheckpoint = Get-ActiveCheckpoint/u,
    "host-side checkpoint progress writer must exist before the current-state path uses it",
  );
  assert.match(source, /merge-file', '--stdout'/u);
  assert.match(source, /did not merge cleanly/u);
  assert.match(source, /RELAY_CHECKPOINT_DIRTY:/u);
  assert.match(source, /RELAY_CHECKPOINT_DIRTY_SUMMARY:/u);
  assert.match(source, /changedMetaSettings/u);
  assert.match(source, /function Get-CheckpointDirtySummary/u);
  assert.match(source, /function Restore-RemoteMetaOnlyWorkspace/u);
  assert.match(source, /@\(' M', ' D', '\?\?'\)/u);
  assert.match(
    source,
    /'restore', '--source=HEAD', '--worktree', '--', \$statusPath/u,
  );
  assert.match(source, /remoteMetaRestores/u);
  assert.match(source, /removed-untracked/u);
  assert.match(source, /RELAY_CHECKPOINT_FAILURE:/u);
  assert.match(source, /Exception\.Data\['relayStdout'\]/u);
  assert.match(source, /Exception\.Data\['checkpointDirtyJson'\]/u);
  assert.match(source, /post-Unity workspace was not clean/u);
  assert.match(source, /RELAY_CHECKPOINT_PROGRESS:/u);
  assert.match(source, /contentBase64/u);
  assert.match(source, /checkpoint-dirty-diff/u);
  assert.match(source, /CHECKPOINT_WORKSPACE_DIRTY/u);
  assert.match(source, /previousCheckpointRetained/u);
  assert.match(source, /\[Console\]::Out\.WriteLine/u);
  assert.match(source, /RELAY_CHECKPOINT_DIRTY:\{/u);
  assert.match(source, /dirtySummarySuffix/u);
  assert.match(
    source,
    /\$postRefreshGitResult\s*=\s*Invoke-GuestGitState\s+\$false/u,
  );
  assert.match(
    source,
    /\$configuredOverlays\s*=\s*\$ApprovedOverlaysJson\s*\|\s*ConvertFrom-Json/u,
  );
  assert.doesNotMatch(
    source,
    /\$configuredOverlays\s*=\s*@\(\s*\$ApprovedOverlaysJson\s*\|\s*ConvertFrom-Json/u,
  );
  assert.doesNotMatch(source, /reset\s+--hard|clean\s+-/iu);
  assert.doesNotMatch(source, /'add'\s*,|'commit'\s*,|'push'\s*,/iu);
  assert.ok(
    source.indexOf("Checkpoint-VM") < source.indexOf("$canaryPassed = $true"),
  );
  assert.ok(
    source.indexOf("$canaryPassed = $true") <
      source.indexOf("$checkpoint | Remove-VMCheckpoint"),
  );
});

test("checkpoint maintenance restores only pure unstaged Unity meta drift", () => {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.resolve("tests/powershell/Test-CheckpointMetaPolicy.ps1"),
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    trackedMetaRestored: true,
    mixedWorkspacePreserved: true,
    untrackedMetaRemoved: true,
    stagedMetaPreserved: true,
  });
});

test("checkpoint refresh gives a large media update one bounded transfer window", () => {
  const source = fs.readFileSync(
    new URL(
      "../../scripts/hyperv/Update-ProjectReadyCheckpoint.ps1",
      import.meta.url,
    ),
    "utf8",
  );
  const gitHelperSource = fs.readFileSync(
    new URL("../../scripts/hyperv/Workspace-Git.ps1", import.meta.url),
    "utf8",
  );
  assert.match(source, /-TimeoutSeconds 1800/u);
  assert.match(source, /'checkpoint-main-fetch' @\{\} 900 1 1000/u);
  assert.match(source, /@\{\} 600 'checkpoint-main-fast-forward'/u);
  assert.match(gitHelperSource, /ValidateRange\(1, 1200\)/u);
  const directSource = fs.readFileSync(
    new URL("../../scripts/hyperv/PowerShell-Direct.ps1", import.meta.url),
    "utf8",
  );
  assert.match(directSource, /ValidateRange\(1, 3600\)/u);
});

test("checkpoint UnitySkills stability tolerates a bounded long main-thread import", () => {
  const source = fs.readFileSync(
    new URL(
      "../../scripts/hyperv/Update-ProjectReadyCheckpoint.ps1",
      import.meta.url,
    ),
    "utf8",
  );
  const gate = source.match(
    /function Wait-GuestUnitySkills[\s\S]*?function Invoke-UnityAssetRefresh/u,
  )?.[0];
  assert.ok(gate, "UnitySkills checkpoint gate must remain present");
  assert.match(gate, /-TimeoutSeconds 1800/u);
  assert.match(gate, /AddMinutes\(\$StableTimeoutMinutes\)/u);
  assert.match(gate, /-TimeoutSec 180/u);
  assert.match(gate, /after \$probeCount probes/u);
  assert.match(gate, /Diagnostic: \$failureDiagnostic/u);
  assert.match(gate, /pendingTitles/u);
  assert.match(gate, /freeGb/u);
  assert.match(gate, /freeVirtualGb/u);
  assert.match(gate, /Win32_PageFileUsage/u);
  assert.match(gate, /recentSignals/u);
  assert.match(gate, /ProgramData\\Relay\\UnityEditor\\Editor\.log/u);
  assert.doesNotMatch(gate, /commandLine\s*=/iu);
});

test("checkpoint refresh narrowly recovers a proven post-refresh UnitySkills consumer stall", () => {
  const source = fs.readFileSync(
    new URL(
      "../../scripts/hyperv/Update-ProjectReadyCheckpoint.ps1",
      import.meta.url,
    ),
    "utf8",
  );
  const recovery = source.match(
    /function Restart-GuestUnityEditorAfterRefresh[\s\S]*?function Invoke-UnityAssetRefresh/u,
  )?.[0];
  assert.ok(recovery, "post-refresh UnityEditor recovery must remain present");
  assert.match(source, /ValidateRange\(1, 20\).*PostRefreshStableTimeoutMinutes = 5/u);
  assert.match(source, /Wait-GuestUnitySkills `\s*-TimeoutMinutes \$PostRefreshStableTimeoutMinutes/u);
  assert.match(source, /post-refresh-stable-timeout/u);
  assert.match(source, /unityeditor-post-refresh-restarted/u);
  assert.match(recovery, /Get-ScheduledTask -TaskPath \$taskPath -TaskName \$taskName/u);
  assert.match(recovery, /must use Interactive logon/u);
  assert.match(recovery, /with Highest run level/u);
  assert.match(recovery, /does not execute Unity\.exe/u);
  assert.match(recovery, /Expected one Unity process/u);
  assert.match(recovery, /unique owner of loopback service port 8090/u);
  assert.match(recovery, /UnityDialogGuard is not stably idle/u);
  assert.match(recovery, /Asset Pipeline Refresh\.\*Total:/u);
  assert.match(recovery, /Stop-ScheduledTask/u);
  assert.match(recovery, /Start-ScheduledTask/u);
  assert.doesNotMatch(recovery, /Stop-Process|Restart-VM|Stop-VM/u);
});

test("Luna's checkpoint.refresh action delegates to the guarded maintenance runner", async () => {
  const calls = [];
  const ops = new OpsEngine(
    {
      config: {},
      store: { getTask: () => null },
      scheduler: {},
      repairManager: {},
      checkpointMaintenance: {
        async runNow(options) {
          calls.push(options);
          return {
            ok: true,
            results: [{ workerId: options.workerId, ok: true }],
          };
        },
      },
    },
    {
      sessionRunner: { run: async () => null },
      recoverySessionRunner: { run: async () => null },
    },
  );
  const result = await ops.performAction(
    { incidentId: null },
    {
      type: "checkpoint.refresh",
      targetId: "worker-maintenance",
      reason: "Retry the failed daily checkpoint after Unity recovered",
    },
    { diagnosis: "Unity is healthy again" },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      workerId: "worker-maintenance",
      reason: "Retry the failed daily checkpoint after Unity recovered",
    },
  ]);

  const schema = JSON.parse(
    fs.readFileSync(
      new URL("../../server/ops-output.schema.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(
    schema.properties.actions.items.properties.type.enum.includes(
      "checkpoint.refresh",
    ),
  );
});
