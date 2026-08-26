import { config } from "./config.mjs";
import { createAdapter } from "./adapters/index.mjs";
import { BuildDispatcher } from "./build-dispatcher.mjs";
import { BuildStatusMonitor } from "./build-status-monitor.mjs";
import { CheckpointMaintenance } from "./checkpoint-maintenance.mjs";
import { DailyAuditLogger } from "./daily-audit-log.mjs";
import { Store } from "./db.mjs";
import { PipelineHttpServer } from "./http.mjs";
import { GuardianClient } from "./guardian-client.mjs";
import { GitLabClient } from "./gitlab-client.mjs";
import { OzdqpBuildClient } from "./ozdqp-build-client.mjs";
import { OpsEngine } from "./ops-engine.mjs";
import { ProjectManagementClient } from "./project-management-client.mjs";
import { ProjectManagementSessionStore } from "./project-management-session-store.mjs";
import { RepairManager } from "./repair-manager.mjs";
import { Scheduler } from "./scheduler.mjs";
import { TaskCompletionService } from "./task-completion-service.mjs";

const store = new Store(config);
const auditLog = new DailyAuditLogger({
  directory: config.auditLogDirectory,
  enabled: config.auditLogEnabled,
  timeZone: config.auditLogTimeZone,
});
const stopAuditCompletionListener = store.onEvent((event) => {
  if (event.type !== "turn.delivered" || !event.turnId) return;
  const turn = store.getTurn(event.turnId);
  const task = turn ? store.getTask(turn.taskId) : null;
  auditLog.recordTaskCompletion({ event, task, turn });
});
const buildClient = new OzdqpBuildClient({
  endpoint: config.ozdqpBuildApiUrl,
  apiKey: config.ozdqpBuildApiKey,
  timeoutMs: config.ozdqpBuildTimeoutMs,
});
const buildDispatcher = new BuildDispatcher({
  store,
  client: buildClient,
  pollIntervalMs: config.ozdqpBuildPollIntervalMs,
  retryScheduleMs: config.ozdqpBuildRetryScheduleMs,
  retryMaxMs: config.ozdqpBuildRetryMaxMs,
});
const buildStatusMonitor = new BuildStatusMonitor({
  store,
  client: buildClient,
  pollIntervalMs: config.ozdqpBuildStatusPollIntervalMs,
  failedPollIntervalMs: config.ozdqpBuildFailedStatusPollIntervalMs,
  retryScheduleMs: config.ozdqpBuildRetryScheduleMs,
  retryMaxMs: config.ozdqpBuildRetryMaxMs,
});
const stopBuildDispatchWakeup = store.onEvent((event) => {
  if (event.type === "build.dispatch.queued") buildDispatcher.notify();
  if (event.type === "build.dispatch.accepted") buildStatusMonitor.notify();
});
const guardian = new GuardianClient(config, {
  onEvent: (event) => store.emit(event),
});
guardian.start();
const adapter = createAdapter(config);
const runtime = await adapter.initialize();
const scheduler = new Scheduler({ config, store, adapter });
const checkpointMaintenance = new CheckpointMaintenance({
  config,
  store,
  scheduler,
  adapter,
});
const repairManager = new RepairManager(
  { config, store },
  { restartCoordinator: guardian },
);
let projectManagementSessionStore = null;
let projectManagementInitialSessionState = null;
if (config.projectManagementEnabled) {
  projectManagementSessionStore = new ProjectManagementSessionStore({
    statePath: config.projectManagementSessionStatePath,
    powershellCommand: config.powershellCommand,
    scriptPath: config.projectManagementSessionProtectionScript,
  });
  try {
    projectManagementInitialSessionState =
      await projectManagementSessionStore.load();
  } catch (error) {
    console.warn(
      `Project-management sessions could not be restored; encrypted state was left untouched: ${error.message}`,
    );
    projectManagementSessionStore = null;
  }
}
const projectManagementClient = config.projectManagementEnabled
  ? new ProjectManagementClient({
      baseUrl: config.projectManagementBaseUrl,
      timeoutMs: config.projectManagementTimeoutMs,
      sessionTtlMs: config.projectManagementSessionTtlMs,
      sessionStore: projectManagementSessionStore,
      initialSessionState: projectManagementInitialSessionState,
    })
  : null;
const gitlabClient = new GitLabClient({
  baseUrl: config.gitlabBaseUrl,
  tokenFile: config.gitlabTokenFile,
  timeoutMs: config.gitlabTimeoutMs,
});
const taskCompletionService = new TaskCompletionService({
  store,
  gitlabClient,
  projectManagementClient,
});
const ops = new OpsEngine({
  config,
  store,
  scheduler,
  repairManager,
  restartCoordinator: guardian,
  checkpointMaintenance,
});
const api = new PipelineHttpServer({
  config,
  store,
  scheduler,
  ops,
  guardian,
  auditLog,
  checkpointMaintenance,
  projectManagementClient,
  taskCompletionService,
});

await api.listen();
if (config.ozdqpBuildEnabled) {
  buildDispatcher.start();
  buildStatusMonitor.start();
}
await scheduler.start({ paused: !runtime.ready });
await ops.start();
checkpointMaintenance.start();
if (!runtime.ready) {
  store.emit({
    type: "system.runtime.unhealthy",
    phase: "system",
    level: "error",
    message:
      "Relay host preflight is not ready; System Codex will diagnose recovery",
    data: { runtime },
  });
}

console.log(
  `Relay pipeline API listening on http://${config.host}:${config.port}`,
);
console.log(`Adapter: ${config.adapter}; access tokens: disabled`);
console.log(
  `Hyper-V access: ${runtime.hyperv.canManage ? "ready" : "unavailable"}; Codex: ${
    runtime.codex.authenticated
      ? runtime.codex.version || "authenticated"
      : "not authenticated"
  }; checkpoints: ${runtime.checkpointsEnabled ? "enabled" : "disabled"}`,
);
if (!runtime.ready) {
  console.warn(
    "Scheduler started paused because the Hyper-V/Codex host preflight is not ready. Check GET /api/runtime.",
  );
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Received ${signal}; stopping pipeline service`);
  buildDispatcher.stop();
  buildStatusMonitor.stop();
  stopBuildDispatchWakeup();
  checkpointMaintenance.stop();
  ops.stop();
  guardian.stop();
  scheduler.stop();
  const drained = await scheduler.waitForIdle();
  const opsDrained = await ops.waitForIdle();
  const checkpointMaintenanceDrained =
    await checkpointMaintenance.waitForIdle(15_000);
  const buildDispatchDrained = await buildDispatcher.waitForIdle(
    Math.max(15_000, config.ozdqpBuildTimeoutMs + 1_000),
  );
  const buildStatusDrained = await buildStatusMonitor.waitForIdle(
    Math.max(15_000, config.ozdqpBuildTimeoutMs + 1_000),
  );
  if (!drained) {
    console.warn(
      "Timed out waiting for active turns to stop; startup reconciliation will preserve their workers",
    );
  }
  if (!opsDrained) {
    console.warn(
      "Timed out waiting for active Ops conversations to stop; unrestricted recovery turns will be re-queued on startup",
    );
  }
  if (!checkpointMaintenanceDrained) {
    console.warn(
      "Timed out waiting for checkpoint maintenance to stop; its failed attempt will be retried at the next scheduled hour",
    );
  }
  if (!buildDispatchDrained) {
    console.warn(
      "Timed out waiting for the active OZDQP request; startup reconciliation will retry it idempotently",
    );
  }
  if (!buildStatusDrained) {
    console.warn(
      "Timed out waiting for OZDQP build progress checks; monitoring will resume on startup",
    );
  }
  await api.close();
  stopAuditCompletionListener();
  auditLog.close();
  store.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(
    signal,
    () => void shutdown(signal).finally(() => process.exit(0)),
  );
}
