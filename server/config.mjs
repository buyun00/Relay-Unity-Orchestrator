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

const requestedAdapter = (
  process.env.PIPELINE_ADAPTER || "hyperv"
).toLowerCase();
if (requestedAdapter !== "hyperv") {
  throw new Error(
    `Unsupported PIPELINE_ADAPTER: ${requestedAdapter}. The production mock adapter has been removed; use hyperv.`,
  );
}
const adapter = "hyperv";

const adminToken = process.env.PIPELINE_ADMIN_TOKEN?.trim() || "";
if (adapter === "hyperv" && !adminToken) {
  throw new Error(
    "PIPELINE_ADMIN_TOKEN is required when PIPELINE_ADAPTER=hyperv",
  );
}

const dataDirectory = path.resolve(
  process.env.PIPELINE_DATA_DIR || path.join(projectRoot, ".pipeline-data"),
);

export const config = Object.freeze({
  version: "0.1.0",
  projectRoot,
  serverDirectory,
  dataDirectory,
  databasePath: path.join(dataDirectory, "pipeline.sqlite"),
  uploadDirectory: path.join(dataDirectory, "uploads"),
  logDirectory: path.join(dataDirectory, "logs"),
  // Listen on every interface by default so devices on the local network can
  // reach the control API through the host machine's LAN address.
  host: process.env.PIPELINE_HOST || "0.0.0.0",
  port: integer(process.env.PIPELINE_PORT, 4317),
  adapter,
  adminToken,
  authRequired: Boolean(adminToken),
  allowedOrigins: (process.env.PIPELINE_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  sessionTtlMs:
    integer(process.env.PIPELINE_SESSION_TTL_HOURS, 12) * 60 * 60 * 1000,
  requestBodyLimitBytes:
    integer(process.env.PIPELINE_BODY_LIMIT_MB, 2) * 1024 * 1024,
  uploadLimitBytes:
    integer(process.env.PIPELINE_UPLOAD_LIMIT_MB, 25) * 1024 * 1024,
  schedulerIntervalMs: integer(
    process.env.PIPELINE_SCHEDULER_INTERVAL_MS,
    1_500,
  ),
  healthIntervalMs: integer(process.env.PIPELINE_HEALTH_INTERVAL_MS, 30_000),
  checkpointsEnabled: boolean(process.env.PIPELINE_CHECKPOINTS_ENABLED, false),
  allowUnitySaveSkip: boolean(
    process.env.PIPELINE_ALLOW_UNITY_SAVE_SKIP,
    false,
  ),
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
  codexTimeoutMs:
    integer(process.env.PIPELINE_CODEX_TIMEOUT_MINUTES, 90) * 60 * 1000,
  powershellCommand:
    process.env.PIPELINE_POWERSHELL_COMMAND || "powershell.exe",
});
