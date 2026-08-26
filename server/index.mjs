import fs from "node:fs";

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
import { QaHubM2MService } from "./qa-hub-m2m.mjs";
import { QaHubM2mSqliteStore } from "./qa-hub-m2m-store.mjs";
import {
  normalizeQaHubWebhookEvent,
  QaHubWebhookOutbox,
} from "./qa-hub-webhook-outbox.mjs";
import { RepairManager } from "./repair-manager.mjs";
import { Scheduler } from "./scheduler.mjs";
import { TaskCompletionService } from "./task-completion-service.mjs";

function readSecretFile(filePath, label) {
  if (!filePath) throw new Error(`${label} file is not configured`);
  const value = fs.readFileSync(filePath, "utf8").trim();
  if (!value) throw new Error(`${label} file is empty`);
  return value;
}

function qaHubProjectMap(raw) {
  const result = new Map();
  for (const entry of String(raw || "").split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) continue;
    const qaProjectKey = entry.slice(0, separator).trim();
    const relayProjectId = entry.slice(separator + 1).trim();
    if (qaProjectKey && relayProjectId) result.set(qaProjectKey, relayProjectId);
  }
  if (result.size === 0) {
    throw new Error("QA Hub project allowlist is empty or invalid");
  }
  return result;
}

function qaHubWebhookEndpoint(value) {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("QA Hub webhook endpoint must be credential-free loopback HTTP");
  }
  return endpoint.toString();
}

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
let qaHubM2mService = null;
let qaHubWebhookOutbox = null;
let stopQaHubDurableEventSink = null;
if (config.qaHubM2mEnabled) {
  const m2mToken = readSecretFile(
    config.qaHubM2mTokenFile,
    "QA Hub M2M token",
  );
  const webhookSecret = readSecretFile(
    config.qaHubWebhookSecretFile,
    "QA Hub webhook secret",
  );
  const projectMap = qaHubProjectMap(config.qaHubProjectMap);
  const webhookEndpoint = qaHubWebhookEndpoint(config.qaHubWebhookUrl);
  const qaHubPersistence = new QaHubM2mSqliteStore({ store });
  const m2mAdapter = qaHubPersistence.m2mAdapter();
  qaHubM2mService = new QaHubM2MService({
    store,
    scheduler,
    relayInstanceId: config.qaHubRelayInstanceId,
    token: m2mToken,
    scopes: config.qaHubM2mScopes,
    projectMap,
    idempotency: m2mAdapter,
    bindings: m2mAdapter,
    atomicPersistence: qaHubPersistence.atomicPersistence(),
    uploadDirectory: config.uploadDirectory,
    maxAttachmentBytes: config.uploadLimitBytes,
  });
  qaHubWebhookOutbox = new QaHubWebhookOutbox({
    store,
    adapter: qaHubPersistence.outboxAdapter(),
    relayInstanceId: config.qaHubRelayInstanceId,
    endpoint: webhookEndpoint,
    secret: webhookSecret,
    pollIntervalMs: config.qaHubWebhookPollMs,
    retryScheduleMs: [
      1_000,
      5_000,
      30_000,
      Math.min(300_000, config.qaHubWebhookRetryMaxMs),
      config.qaHubWebhookRetryMaxMs,
    ],
  });
  const persistQaHubEvent = (event) => {
    if (!event.taskId) return;
    const binding = qaHubPersistence.getHandoffByTaskId(event.taskId);
    if (!binding) return;
    const task = store.getTask(event.taskId);
    const project = task ? store.getProject(task.projectId) : null;
    const record = normalizeQaHubWebhookEvent(
      {
        ...event,
        data: {
          ...(event.data || {}),
          ...(event.type === "turn.delivered"
            ? {
                buildRequirement: {
                  required: project?.autoBuildEnabled === true,
                  projectKey: project?.buildProjectKey || null,
                },
              }
            : {}),
        },
        handoffId: binding.handoffId,
        attemptId: binding.attemptId,
        qaInstanceId: binding.qaInstanceId,
        externalRevision: event.id,
      },
      config.qaHubRelayInstanceId,
    );
    if (record) qaHubPersistence.enqueue(record);
  };
  stopQaHubDurableEventSink = store.onDurableEvent(persistQaHubEvent);
  for (const event of qaHubPersistence.listBoundEvents()) {
    try {
      persistQaHubEvent(event);
    } catch (error) {
      // The durable outbox body is immutable. A deployment may deliberately
      // normalize future events differently, so startup recovery must retain
      // the already-recorded delivery instead of rewriting its payload.
      if (error?.code !== "INTEGRATION_EVENT_CONFLICT") throw error;
    }
  }
}
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
  qaHubM2mService,
});

await api.listen();
qaHubWebhookOutbox?.start();
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
  await qaHubWebhookOutbox?.stop();
  stopQaHubDurableEventSink?.();
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
