import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
} from "./codex-settings.mjs";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverDirectory, "..");

function integer(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function integerList(value, fallback) {
  const parsed = String(value || "")
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0);
  return parsed.length ? parsed : fallback;
}

function hourList(value, fallback) {
  const parsed = String(value || "")
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 23);
  return parsed.length ? [...new Set(parsed)].sort((a, b) => a - b) : fallback;
}

function stringList(value, fallback = []) {
  const parsed = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
}

const requestedAdapter = (
  process.env.PIPELINE_ADAPTER || "hyperv"
).toLowerCase();
if (requestedAdapter !== "hyperv") {
  throw new Error(
    `Unsupported PIPELINE_ADAPTER: ${requestedAdapter}. The production mock adapter has been removed; use hyperv.`,
  );
}
const adapter = "hyperv";

const dataDirectory = path.resolve(
  process.env.PIPELINE_DATA_DIR || path.join(projectRoot, ".pipeline-data"),
);
const logDirectory = path.join(dataDirectory, "logs");
const auditLogDirectory = path.resolve(
  process.env.PIPELINE_AUDIT_LOG_DIR || path.join(logDirectory, "daily-audit"),
);

export const config = Object.freeze({
  version: "0.3.2",
  projectRoot,
  serverDirectory,
  dataDirectory,
  databasePath: path.join(dataDirectory, "pipeline.sqlite"),
  uploadDirectory: path.join(dataDirectory, "uploads"),
  logDirectory,
  auditLogEnabled: boolean(process.env.PIPELINE_AUDIT_LOG_ENABLED, true),
  auditLogDirectory,
  auditLogTimeZone:
    process.env.PIPELINE_AUDIT_LOG_TIME_ZONE?.trim() || "Asia/Shanghai",
  // Listen on every interface by default so devices on the local network can
  // reach the control API through the host machine's LAN address.
  host: process.env.PIPELINE_HOST || "0.0.0.0",
  port: integer(process.env.PIPELINE_PORT, 4317),
  adapter,
  allowedOrigins: (process.env.PIPELINE_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  requestBodyLimitBytes:
    integer(process.env.PIPELINE_BODY_LIMIT_MB, 2) * 1024 * 1024,
  uploadLimitBytes:
    integer(process.env.PIPELINE_UPLOAD_LIMIT_MB, 25) * 1024 * 1024,
  projectManagementEnabled: boolean(
    process.env.PIPELINE_PROJECT_MANAGEMENT_ENABLED,
    true,
  ),
  projectManagementBaseUrl:
    process.env.PIPELINE_PROJECT_MANAGEMENT_BASE_URL?.trim() ||
    "https://50qweb.jiaxianghudong.com",
  projectManagementTimeoutMs: integer(
    process.env.PIPELINE_PROJECT_MANAGEMENT_TIMEOUT_MS,
    10_000,
  ),
  projectManagementSessionTtlMs:
    integer(process.env.PIPELINE_PROJECT_MANAGEMENT_SESSION_HOURS, 12) *
    60 *
    60 *
    1000,
  projectManagementSessionStatePath: path.resolve(
    process.env.PIPELINE_PROJECT_MANAGEMENT_SESSION_STATE_PATH?.trim() ||
      path.join(dataDirectory, "project-management-sessions.dpapi.json"),
  ),
  projectManagementSessionProtectionScript: path.join(
    projectRoot,
    "scripts",
    "Protect-ProjectManagementSessions.ps1",
  ),
  gitlabBaseUrl:
    process.env.PIPELINE_GITLAB_BASE_URL?.trim() || "http://git.dominogm.com",
  gitlabTokenFile: process.env.PIPELINE_GITLAB_TOKEN_FILE?.trim() || null,
  gitlabTimeoutMs: integer(process.env.PIPELINE_GITLAB_TIMEOUT_MS, 15_000),
  schedulerIntervalMs: integer(
    process.env.PIPELINE_SCHEDULER_INTERVAL_MS,
    1_500,
  ),
  healthIntervalMs: integer(process.env.PIPELINE_HEALTH_INTERVAL_MS, 30_000),
  checkpointsEnabled: boolean(process.env.PIPELINE_CHECKPOINTS_ENABLED, false),
  checkpointMaintenanceEnabled: boolean(
    process.env.PIPELINE_CHECKPOINT_MAINTENANCE_ENABLED,
    false,
  ),
  checkpointMaintenanceHours: hourList(
    process.env.PIPELINE_CHECKPOINT_MAINTENANCE_HOURS,
    [5, 6, 7],
  ),
  checkpointMaintenanceTimeZone:
    process.env.PIPELINE_CHECKPOINT_MAINTENANCE_TIME_ZONE?.trim() ||
    "Asia/Shanghai",
  checkpointMaintenanceScanIntervalMs: integer(
    process.env.PIPELINE_CHECKPOINT_MAINTENANCE_SCAN_INTERVAL_MS,
    30_000,
  ),
  checkpointMaintenanceStatePath: path.join(
    dataDirectory,
    "checkpoint-maintenance.json",
  ),
  checkpointRetentionCount: Math.max(
    2,
    integer(process.env.PIPELINE_CHECKPOINT_RETENTION_COUNT, 2),
  ),
  allowUnitySaveSkip: boolean(
    process.env.PIPELINE_ALLOW_UNITY_SAVE_SKIP,
    false,
  ),
  unityGuestLocalEndpoint:
    process.env.PIPELINE_UNITY_GUEST_LOCAL_ENDPOINT?.trim() ||
    "http://127.0.0.1:8090",
  codexCommand: process.env.PIPELINE_CODEX_COMMAND || "codex",
  codexHome: process.env.CODEX_HOME?.trim() || null,
  codexModel: process.env.PIPELINE_CODEX_MODEL?.trim() || DEFAULT_CODEX_MODEL,
  codexReasoningEffort:
    process.env.PIPELINE_CODEX_REASONING_EFFORT?.trim() ||
    DEFAULT_CODEX_REASONING_EFFORT,
  codexServiceTier:
    process.env.PIPELINE_CODEX_SERVICE_TIER?.trim() || "default",
  gitAuthorName:
    process.env.PIPELINE_GIT_AUTHOR_NAME?.trim() || "Relay Unity Orchestrator",
  gitAuthorEmail:
    process.env.PIPELINE_GIT_AUTHOR_EMAIL?.trim() ||
    "relay-unity-orchestrator@localhost",
  approvedOverlayPaths: stringList(process.env.PIPELINE_APPROVED_OVERLAY_PATHS),
  ozdqpBuildEnabled: boolean(process.env.OZDQP_BUILD_ENABLED, true),
  ozdqpBuildApiUrl:
    process.env.OZDQP_BUILD_API_URL?.trim() ||
    "http://10.100.3.209:8088/api/v1/builds",
  ozdqpBuildRepositoryUrl:
    process.env.OZDQP_BUILD_REPOSITORY_URL?.trim() ||
    "http://git.dominogm.com/diaoyu/ozdqp.git",
  ozdqpBuildApiKey: process.env.OZDQP_BUILD_API_KEY?.trim() || null,
  ozdqpBuildTimeoutMs: integer(process.env.OZDQP_BUILD_TIMEOUT_MS, 10_000),
  ozdqpBuildPollIntervalMs: integer(
    process.env.OZDQP_BUILD_POLL_INTERVAL_MS,
    1_000,
  ),
  ozdqpBuildStatusPollIntervalMs: integer(
    process.env.OZDQP_BUILD_STATUS_POLL_INTERVAL_MS,
    5_000,
  ),
  ozdqpBuildFailedStatusPollIntervalMs: integer(
    process.env.OZDQP_BUILD_FAILED_STATUS_POLL_INTERVAL_MS,
    30_000,
  ),
  ozdqpBuildRetryScheduleMs: integerList(
    process.env.OZDQP_BUILD_RETRY_SCHEDULE_MS,
    [1_000, 2_000, 5_000, 10_000, 30_000, 60_000],
  ),
  ozdqpBuildRetryMaxMs: integer(process.env.OZDQP_BUILD_RETRY_MAX_MS, 300_000),
  codexTimeoutMs:
    integer(process.env.PIPELINE_CODEX_TIMEOUT_MINUTES, 90) * 60 * 1000,
  powershellCommand:
    process.env.PIPELINE_POWERSHELL_COMMAND || "powershell.exe",
  gitCommand: process.env.PIPELINE_GIT_COMMAND || "git",
  opsEnabled: boolean(process.env.PIPELINE_OPS_ENABLED, true),
  opsAutoHandle: boolean(process.env.PIPELINE_OPS_AUTO_HANDLE, true),
  opsAutoDeploy: boolean(process.env.PIPELINE_OPS_AUTO_DEPLOY, true),
  opsMaxAttempts: integer(process.env.PIPELINE_OPS_MAX_ATTEMPTS, 4),
  opsMaxConcurrentSessions: integer(
    process.env.PIPELINE_OPS_MAX_CONCURRENT_SESSIONS,
    4,
  ),
  opsSupervisorIntervalMs: integer(
    process.env.PIPELINE_OPS_SUPERVISOR_INTERVAL_MS,
    5 * 60 * 1000,
  ),
  opsCodexModel: process.env.PIPELINE_OPS_CODEX_MODEL?.trim() || "gpt-5.6-luna",
  opsCodexReasoningEffort:
    process.env.PIPELINE_OPS_CODEX_REASONING_EFFORT?.trim() || "max",
  opsCodexFastMode: boolean(process.env.PIPELINE_OPS_CODEX_FAST_MODE, false),
  opsRepairCodexModel:
    process.env.PIPELINE_OPS_REPAIR_CODEX_MODEL?.trim() || "gpt-5.6-sol",
  opsRepairCodexReasoningEffort:
    process.env.PIPELINE_OPS_REPAIR_CODEX_REASONING_EFFORT?.trim() || "xhigh",
  opsRepairCodexFastMode: boolean(
    process.env.PIPELINE_OPS_REPAIR_CODEX_FAST_MODE,
    false,
  ),
  opsRepairCodexTimeoutMs:
    integer(process.env.PIPELINE_OPS_REPAIR_CODEX_TIMEOUT_MINUTES, 0) *
    60 *
    1000,
  opsRepairTaskStartWaitMs: integer(
    process.env.PIPELINE_OPS_REPAIR_TASK_START_WAIT_MS,
    120_000,
  ),
  repairDirectory: path.join(dataDirectory, "repairs"),
  deploymentStatePath: path.join(dataDirectory, "deployment-state.json"),
  guardianEnabled: boolean(process.env.PIPELINE_GUARDIAN_ENABLED, true),
  guardianHost: process.env.PIPELINE_GUARDIAN_HOST || "0.0.0.0",
  guardianPort: integer(process.env.PIPELINE_GUARDIAN_PORT, 4318),
  guardianIntervalMs: integer(process.env.PIPELINE_GUARDIAN_INTERVAL_MS, 5_000),
  guardianFailureThreshold: integer(
    process.env.PIPELINE_GUARDIAN_FAILURE_THRESHOLD,
    3,
  ),
  guardianRestartCooldownMs: integer(
    process.env.PIPELINE_GUARDIAN_RESTART_COOLDOWN_MS,
    20_000,
  ),
  relayEntry: process.env.PIPELINE_RELAY_ENTRY || "server/index.mjs",
  webEntry: process.env.PIPELINE_WEB_ENTRY || "server/web.mjs",
  webPort: integer(process.env.PORT, 3000),
  internalWebPort: integer(
    process.env.RELAY_INTERNAL_WEB_PORT,
    integer(process.env.PORT, 3000) + 1,
  ),
});
