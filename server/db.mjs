import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  asBoolean,
  executionProfile,
  HttpError,
  id,
  now,
  parseJson,
  slug,
  stringifyJson,
} from "./util.mjs";
import {
  DEFAULT_CODEX_FAST_MODE,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
} from "./codex-settings.mjs";

const ACTIVE_TURN_STATUSES = [
  "queued",
  "preparing",
  "running",
  "saving",
  "cancel_requested",
];
const EXECUTING_TURN_STATUSES = [
  "preparing",
  "running",
  "saving",
  "cancel_requested",
];

const PROTECTED_LEGACY_DELIVERY_RETRIES = [
  {
    taskId: "task-0c378492-19ee-45be-8397-ff85af8cdf1d",
    turnId: "turn-85d5b579-2f9f-4c18-b5fc-be11c940cac4",
    threadId: "019fad77-3213-7513-b665-5daf2c007987",
    workerName: "lin-worker-01",
    branch: "codex/task-0019-hall-3-empty-top-left-gifts-grid",
    head: "35a58db626a789df10b98cdf4a554ff029ab37df",
    files: [
      {
        code: " M",
        path: "baloot_client/Assets/AppAssets/hall/scripts/Systems/Hall/View/GiftPackEntryBar.cs",
        originalPath: null,
        gitBlob: "c70ac045e25981f17e42f5ed73dcb7fe0010bc19",
        sha256:
          "b26b9b9a3d718cd6e1be171dc0eb3498a0834587f82953f9324c21c49b72c3f0",
        unsafeReason: null,
      },
    ],
  },
];

function sourceEventKey(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function stringArray(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function exactJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deliveryAuditFingerprint({
  branch,
  head,
  changedFiles,
  validation,
  files,
}) {
  const records = files
    .map(
      (file) =>
        `${file.code}\0${file.originalPath || ""}\0${file.path}\0${file.gitBlob.toLowerCase()}\0${file.sha256.toLowerCase()}`,
    )
    .sort();
  const payload = [
    "relay-delivery-audit-v1",
    branch,
    head.toLowerCase(),
    [...changedFiles].sort().join("\0"),
    validation.join("\0"),
    records.join("\0"),
  ].join("\0");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function parseLegacyCodexJsonl(jsonlPath) {
  let threadId = null;
  let final = null;
  const content = fs.readFileSync(jsonlPath, "utf8");
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const event = parseJson(line, null);
    if (!event) continue;
    if (event.type === "thread.started") {
      threadId =
        event.thread_id || event.threadId || event.thread?.id || threadId;
    }
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message"
    ) {
      const text =
        typeof event.item.text === "string"
          ? event.item.text
          : typeof event.item.message === "string"
            ? event.item.message
            : "";
      const candidate = parseJson(text.trim(), null);
      if (candidate && typeof candidate === "object") final = candidate;
    }
  }
  return { threadId, final };
}

function legacyDeliveryRetryEvidence(config, task, turn, worker) {
  const manifests = [
    ...PROTECTED_LEGACY_DELIVERY_RETRIES,
    ...(Array.isArray(config.legacyDeliveryRetryManifests)
      ? config.legacyDeliveryRetryManifests
      : []),
  ];
  const manifest = manifests.find(
    (candidate) => candidate.taskId === task.id && candidate.turnId === turn.id,
  );
  if (!manifest) return null;
  const refusal = (message) => {
    throw new HttpError(
      409,
      "DELIVERY_RETRY_LEGACY_EVIDENCE_MISMATCH",
      message,
    );
  };
  if (
    task.branchName !== manifest.branch ||
    task.codexThreadId !== manifest.threadId ||
    worker?.name !== manifest.workerName ||
    turn.workerId !== worker?.id
  ) {
    refusal(
      "The protected legacy turn no longer matches its recorded task branch, Codex thread, or attention worker",
    );
  }
  const basename = `${turn.sequence}-${turn.id}`;
  const logDirectory = path.join(config.logDirectory, task.id);
  const finalPath = path.join(logDirectory, `${basename}.final.json`);
  const jsonlPath = path.join(logDirectory, `${basename}.jsonl`);
  if (
    !fs.existsSync(finalPath) ||
    !fs.statSync(finalPath).isFile() ||
    !fs.existsSync(jsonlPath) ||
    !fs.statSync(jsonlPath).isFile()
  ) {
    refusal(
      "The protected legacy turn is missing its original final or JSONL Codex log",
    );
  }
  const final = parseJson(fs.readFileSync(finalPath, "utf8").trim(), null);
  const jsonl = parseLegacyCodexJsonl(jsonlPath);
  if (
    final?.status !== "completed" ||
    jsonl.threadId !== manifest.threadId ||
    !exactJson(final, jsonl.final)
  ) {
    refusal(
      "The protected legacy turn final output does not exactly match its JSONL record and durable Codex thread",
    );
  }
  const changedFiles = stringArray(final.changedFiles);
  const validation = stringArray(final.validation);
  const manifestPaths = manifest.files.map((file) => file.path);
  if (
    changedFiles.length !== manifestPaths.length ||
    !exactJson([...changedFiles].sort(), [...manifestPaths].sort()) ||
    !Array.isArray(final.validation)
  ) {
    refusal(
      "The protected legacy turn final output does not match its immutable complete file set or recorded validation output",
    );
  }
  const audit = {
    version: 1,
    ready: true,
    exact: true,
    safeForDeliveryRetry: true,
    completeFileSet: true,
    branch: manifest.branch,
    head: manifest.head,
    changedFiles,
    validation,
    files: manifest.files.map((file) => ({ ...file })),
    blockedPaths: [],
    message:
      "Recovered exact delivery-only evidence from the protected turn final/JSONL logs and immutable workspace manifest",
  };
  audit.fingerprint = deliveryAuditFingerprint(audit);
  return { final, audit, protectedLegacyEvidence: true };
}

const PROJECT_FIELDS = {
  name: "name",
  repoUrl: "repo_url",
  defaultBranch: "default_branch",
  guestProjectPath: "guest_project_path",
  smbPath: "smb_path",
  unityVersion: "unity_version",
  unitySkillUrl: "unity_skill_url",
  unityHealthUrl: "unity_health_url",
  unitySaveUrl: "unity_save_url",
  checkpointName: "checkpoint_name",
  enabled: "enabled",
  autoBuildEnabled: "auto_build_enabled",
  buildProjectKey: "build_project_key",
};

const WORKER_FIELDS = {
  name: "name",
  vmName: "vm_name",
  projectId: "project_id",
  checkpointName: "checkpoint_name",
  internalIp: "internal_ip",
  corporateIp: "corporate_ip",
  sharePath: "share_path",
  credentialPath: "credential_path",
  enabled: "enabled",
};

function projectFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch,
    guestProjectPath: row.guest_project_path,
    smbPath: row.smb_path,
    unityVersion: row.unity_version,
    unitySkillUrl: row.unity_skill_url,
    unityHealthUrl: row.unity_health_url,
    unitySaveUrl: row.unity_save_url,
    checkpointName: row.checkpoint_name,
    enabled: asBoolean(row.enabled),
    autoBuildEnabled: asBoolean(row.auto_build_enabled),
    buildProjectKey: row.build_project_key || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workerFromRow(row) {
  if (!row) return null;
  const rawHealth = parseJson(row.health_json, {});
  const healthState = (value) => {
    if (["healthy", "warning", "error", "unknown"].includes(value))
      return value;
    if (value === true) return "healthy";
    if (value === false) return "error";
    return "unknown";
  };
  return {
    id: row.id,
    name: row.name,
    vmName: row.vm_name,
    projectId: row.project_id,
    checkpointName: row.checkpoint_name,
    internalIp: row.internal_ip,
    corporateIp: row.corporate_ip,
    sharePath: row.share_path,
    credentialPath: row.credential_path,
    status: row.status,
    enabled: asBoolean(row.enabled),
    currentTurnId: row.current_turn_id,
    health: {
      vm: healthState(rawHealth.vm),
      heartbeat: healthState(rawHealth.heartbeat),
      smb: healthState(rawHealth.smb),
      unity: healthState(rawHealth.unity),
      skill: healthState(rawHealth.skill),
      dialogGuard: healthState(rawHealth.dialogGuard),
      checkedAt: rawHealth.checkedAt || null,
      error: rawHealth.error || null,
    },
    lastSeenAt: row.last_seen_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskFromRow(row) {
  if (!row) return null;
  const projectManagement = row.project_management_defect_id
    ? {
        externalProjectId: row.project_management_external_project_id,
        defectId: row.project_management_defect_id,
        defectUrl: row.project_management_defect_url,
        relayUserName: row.project_management_relay_user_name,
        userId: row.project_management_user_id,
        userName: row.project_management_user_name,
        resolvedAt: row.project_management_resolved_at,
      }
    : null;
  return {
    id: row.id,
    number: row.task_number,
    title: row.title,
    createdBy: row.created_by,
    projectId: row.project_id,
    baseBranch: row.base_branch,
    branchName: row.branch_name,
    codexThreadId: row.codex_thread_id,
    status: row.status,
    latestCommitSha: row.latest_commit_sha,
    priority: row.priority,
    autoRelease: asBoolean(row.auto_release),
    codexModel: row.codex_model,
    codexReasoningEffort: row.codex_reasoning_effort,
    codexFastMode: asBoolean(row.codex_fast_mode),
    projectManagement,
    completion: {
      status: row.completion_status || "idle",
      step: row.completion_step || null,
      errorCode: row.completion_error_code || null,
      errorMessage: row.completion_error_message || null,
      mergeRequestIid: row.merge_request_iid || null,
      mergeRequestUrl: row.merge_request_url || null,
      mergedCommitSha: row.merged_commit_sha || null,
      startedAt: row.completion_started_at || null,
      completedAt: row.completion_completed_at || null,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

function turnFromRow(row) {
  if (!row) return null;
  const result = parseJson(row.codex_final_json, row.codex_final_json);
  return {
    id: row.id,
    taskId: row.task_id,
    sequence: row.sequence,
    userMessage: row.user_message,
    authorName: row.author_name,
    status: row.status,
    priority: row.priority,
    workerId: row.worker_id,
    codexFinal: result,
    result,
    executionMode: row.execution_mode || "full",
    executionProfile: row.execution_profile || "auto",
    deliveryAudit: parseJson(row.delivery_audit_json, null),
    commitSha: row.commit_sha,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function eventFromRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    taskId: row.task_id,
    turnId: row.turn_id,
    workerId: row.worker_id,
    opsTurnId: row.ops_turn_id || null,
    incidentId: row.incident_id || null,
    actorName: row.actor_name,
    level: row.level,
    type: row.type,
    phase: row.phase,
    message: row.message,
    data: parseJson(row.data_json, null),
    createdAt: row.created_at,
  };
}

function buildDispatchFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    turnId: row.turn_id,
    turnSequence: Number(row.turn_sequence),
    taskId: row.task_id,
    projectId: row.project_id,
    projectKey: row.project_key,
    repositoryUrl: row.repository_url,
    branchName: row.branch_name,
    commitSha: row.commit_sha,
    buildType: row.build_type,
    modules: parseJson(row.modules_json, ["all"]),
    playerBaseVersion: Number(row.player_base_version),
    requestedBy: parseJson(row.requested_by_json, null),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    nextAttemptAt: row.next_attempt_at,
    ozdqpJobId: row.ozdqp_job_id,
    lastHttpStatus:
      row.last_http_status == null ? null : Number(row.last_http_status),
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
    failedAt: row.failed_at,
    buildStatus: row.build_status,
    buildStep: row.build_step,
    buildCdnUrl: row.build_cdn_url,
    buildErrorMessage: row.build_error_message,
    buildStartedAt: row.build_started_at,
    buildFinishedAt: row.build_finished_at,
    buildDurationSeconds:
      row.build_duration_seconds == null
        ? null
        : Number(row.build_duration_seconds),
    statusCheckedAt: row.status_checked_at,
    nextStatusCheckAt: row.next_status_check_at,
    statusCheckAttemptCount: Number(row.status_check_attempt_count || 0),
    statusCheckErrorCode: row.status_check_error_code,
    statusCheckErrorMessage: row.status_check_error_message,
  };
}

function isFullCommitSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value);
}

function normalizedRepositoryUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/u, "")
    .toLowerCase();
}

function safeBuildDispatchError(error) {
  const code =
    typeof error?.code === "string" && error.code
      ? error.code.slice(0, 120)
      : "OZDQP_REQUEST_FAILED";
  const status = Number.isInteger(error?.status) ? error.status : null;
  const messages = {
    OZDQP_AUTH_CONFIGURATION_ERROR:
      "OZDQP API rejected its authentication configuration",
    OZDQP_HTTP_RETRYABLE: "OZDQP API returned a retryable HTTP response",
    OZDQP_HTTP_PERMANENT: "OZDQP API returned a permanent HTTP response",
    OZDQP_INVALID_RESPONSE:
      "OZDQP API response did not contain an accepted job ID",
    OZDQP_REQUEST_TIMEOUT: "OZDQP API request timed out",
    OZDQP_NETWORK_ERROR: "OZDQP API request failed before receiving a response",
    OZDQP_STATUS_REQUEST_TIMEOUT: "OZDQP job status request timed out",
    OZDQP_STATUS_NETWORK_ERROR:
      "OZDQP job status request failed before receiving a response",
    OZDQP_STATUS_INVALID_RESPONSE:
      "OZDQP job status response did not contain a complete job identity",
    OZDQP_STATUS_IDENTITY_MISMATCH:
      "OZDQP job status identity did not match the accepted build",
    RELAY_RESTARTED_DURING_DISPATCH:
      "Relay restarted while the OZDQP request was in flight",
  };
  return {
    code,
    status,
    message: messages[code] || "OZDQP build dispatch failed",
  };
}

function attachmentFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    turnId: row.turn_id,
    filename: row.filename,
    path: row.path,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

function opsThreadFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    isSystem: asBoolean(row.is_system),
    clearedThroughSequence: Number(row.cleared_through_sequence || 0),
    codexThreadId: row.codex_thread_id,
    status: row.status,
    codexModel: row.codex_model,
    codexReasoningEffort: row.codex_reasoning_effort,
    codexFastMode: asBoolean(row.codex_fast_mode),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function opsTurnFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    sequence: Number(row.sequence),
    trigger: row.trigger,
    incidentId: row.incident_id,
    targetTaskId: row.target_task_id || null,
    parentOpsTurnId: row.parent_ops_turn_id || null,
    userMessage: row.user_message,
    authorName: row.author_name,
    status: row.status,
    final: parseJson(row.final_json, row.final_json),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function incidentFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    status: row.status,
    severity: row.severity,
    sourceEventId:
      row.source_event_id == null ? null : Number(row.source_event_id),
    taskId: row.task_id,
    turnId: row.turn_id,
    workerId: row.worker_id,
    title: row.title,
    error: row.error,
    context: parseJson(row.context_json, null),
    attemptCount: Number(row.attempt_count || 0),
    lastAction: row.last_action,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function opsActionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    opsTurnId: row.ops_turn_id,
    incidentId: row.incident_id,
    type: row.type,
    targetId: row.target_id,
    message: row.message,
    reason: row.reason,
    status: row.status,
    reversible: asBoolean(row.reversible),
    result: parseJson(row.result_json, null),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function repairRunFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    opsTurnId: row.ops_turn_id,
    incidentId: row.incident_id,
    status: row.status,
    instructions: row.instructions,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    baseSha: row.base_sha,
    commitSha: row.commit_sha,
    codexThreadId: row.codex_thread_id,
    validation: parseJson(row.validation_json, null),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deployedAt: row.deployed_at,
    rolledBackAt: row.rolled_back_at,
  };
}

export class Store {
  constructor(config) {
    this.config = config;
    this.listeners = new Set();
    this.durableEventSinks = new Set();
    fs.mkdirSync(config.dataDirectory, { recursive: true });
    fs.mkdirSync(config.uploadDirectory, { recursive: true });
    fs.mkdirSync(config.logDirectory, { recursive: true });
    this.db = new DatabaseSync(config.databasePath);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.migrate();
    this.reconcileInterruptedWork();
  }

  close() {
    this.db.close();
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        default_branch TEXT NOT NULL DEFAULT 'main',
        guest_project_path TEXT NOT NULL,
        smb_path TEXT NOT NULL,
        unity_version TEXT,
        unity_skill_url TEXT,
        unity_health_url TEXT,
        unity_save_url TEXT,
        checkpoint_name TEXT NOT NULL DEFAULT 'PROJECT_READY',
        enabled INTEGER NOT NULL DEFAULT 1,
        auto_build_enabled INTEGER NOT NULL DEFAULT 0,
        build_project_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        vm_name TEXT NOT NULL UNIQUE,
        project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
        checkpoint_name TEXT NOT NULL DEFAULT 'PROJECT_READY',
        internal_ip TEXT,
        corporate_ip TEXT,
        share_path TEXT NOT NULL,
        credential_path TEXT,
        status TEXT NOT NULL DEFAULT 'ready',
        enabled INTEGER NOT NULL DEFAULT 1,
        current_turn_id TEXT,
        health_json TEXT,
        last_seen_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        task_number INTEGER NOT NULL UNIQUE,
        idempotency_key TEXT,
        title TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT '未记录用户',
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        base_branch TEXT NOT NULL,
        branch_name TEXT NOT NULL UNIQUE,
        codex_thread_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        latest_commit_sha TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        auto_release INTEGER NOT NULL DEFAULT 1,
        codex_model TEXT NOT NULL DEFAULT '${DEFAULT_CODEX_MODEL}',
        codex_reasoning_effort TEXT NOT NULL DEFAULT '${DEFAULT_CODEX_REASONING_EFFORT}',
        codex_fast_mode INTEGER NOT NULL DEFAULT ${DEFAULT_CODEX_FAST_MODE ? 1 : 0},
        project_management_external_project_id TEXT,
        project_management_defect_id TEXT,
        project_management_defect_url TEXT,
        project_management_relay_user_name TEXT,
        project_management_user_id TEXT,
        project_management_user_name TEXT,
        project_management_binding_key TEXT,
        project_management_resolved_at TEXT,
        completion_status TEXT NOT NULL DEFAULT 'idle',
        completion_step TEXT,
        completion_error_code TEXT,
        completion_error_message TEXT,
        merge_request_iid INTEGER,
        merge_request_url TEXT,
        merged_commit_sha TEXT,
        completion_started_at TEXT,
        completion_completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        user_message TEXT NOT NULL,
        author_name TEXT NOT NULL DEFAULT '未记录用户',
        status TEXT NOT NULL DEFAULT 'queued',
        priority INTEGER NOT NULL DEFAULT 0,
        worker_id TEXT REFERENCES workers(id) ON DELETE SET NULL,
        codex_final_json TEXT,
        execution_mode TEXT NOT NULL DEFAULT 'full',
        execution_profile TEXT NOT NULL DEFAULT 'auto',
        delivery_audit_json TEXT,
        commit_sha TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(task_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
        worker_id TEXT REFERENCES workers(id) ON DELETE SET NULL,
        actor_name TEXT,
        level TEXT NOT NULL DEFAULT 'info',
        type TEXT NOT NULL,
        phase TEXT,
        message TEXT NOT NULL,
        data_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        path TEXT NOT NULL,
        content_type TEXT,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_prompt_archive (
        turn_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_number INTEGER NOT NULL,
        task_title TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        author_name TEXT NOT NULL,
        user_message TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        turn_created_at TEXT NOT NULL,
        archived_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS build_dispatches (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id) ON DELETE CASCADE,
        turn_sequence INTEGER NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        project_key TEXT NOT NULL,
        repository_url TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        build_type TEXT NOT NULL DEFAULT 'cdn',
        modules_json TEXT NOT NULL,
        player_base_version INTEGER NOT NULL DEFAULT 1,
        requested_by_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        ozdqp_job_id TEXT,
        last_http_status INTEGER,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT,
        failed_at TEXT,
        build_status TEXT,
        build_step TEXT,
        build_cdn_url TEXT,
        build_error_message TEXT,
        build_started_at TEXT,
        build_finished_at TEXT,
        build_duration_seconds REAL,
        status_checked_at TEXT,
        next_status_check_at TEXT,
        status_check_attempt_count INTEGER NOT NULL DEFAULT 0,
        status_check_error_code TEXT,
        status_check_error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS ops_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New conversation',
        is_system INTEGER NOT NULL DEFAULT 0,
        cleared_through_sequence INTEGER NOT NULL DEFAULT 0,
        codex_thread_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        codex_model TEXT NOT NULL DEFAULT '${DEFAULT_CODEX_MODEL}',
        codex_reasoning_effort TEXT NOT NULL DEFAULT '${DEFAULT_CODEX_REASONING_EFFORT}',
        codex_fast_mode INTEGER NOT NULL DEFAULT ${DEFAULT_CODEX_FAST_MODE ? 1 : 0},
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        severity TEXT NOT NULL DEFAULT 'error',
        source_event_id INTEGER,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        worker_id TEXT REFERENCES workers(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        error TEXT NOT NULL,
        context_json TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_action TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS ops_turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ops_threads(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        trigger TEXT NOT NULL DEFAULT 'manual',
        incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
        target_task_id TEXT,
        parent_ops_turn_id TEXT,
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

      CREATE TABLE IF NOT EXISTS incident_source_event_claims (
        source_event_id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE RESTRICT,
        auto_recovery_turn_id TEXT UNIQUE REFERENCES ops_turns(id) ON DELETE RESTRICT,
        claimed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ops_actions (
        id TEXT PRIMARY KEY,
        ops_turn_id TEXT NOT NULL REFERENCES ops_turns(id) ON DELETE CASCADE,
        incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        target_id TEXT,
        message TEXT,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        reversible INTEGER NOT NULL DEFAULT 1,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS repair_runs (
        id TEXT PRIMARY KEY,
        ops_turn_id TEXT REFERENCES ops_turns(id) ON DELETE SET NULL,
        incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        instructions TEXT NOT NULL,
        branch_name TEXT,
        worktree_path TEXT,
        base_sha TEXT,
        commit_sha TEXT,
        codex_thread_id TEXT,
        validation_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deployed_at TEXT,
        rolled_back_at TEXT
      );

      CREATE INDEX IF NOT EXISTS turns_queue_idx ON turns(status, priority DESC, created_at ASC);
      CREATE INDEX IF NOT EXISTS turns_task_idx ON turns(task_id, sequence DESC);
      CREATE INDEX IF NOT EXISTS task_prompt_archive_task_idx
        ON task_prompt_archive(task_id, sequence ASC);
      CREATE INDEX IF NOT EXISTS events_created_idx ON events(id DESC);
      CREATE INDEX IF NOT EXISTS events_task_idx ON events(task_id, id ASC);
      CREATE INDEX IF NOT EXISTS workers_ready_idx ON workers(enabled, status, project_id);
      CREATE INDEX IF NOT EXISTS ops_turns_queue_idx ON ops_turns(status, created_at ASC);
      CREATE INDEX IF NOT EXISTS ops_turns_thread_idx ON ops_turns(thread_id, sequence ASC);
      CREATE INDEX IF NOT EXISTS incidents_status_idx ON incidents(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS incidents_fingerprint_idx ON incidents(fingerprint, resolved_at);
      CREATE INDEX IF NOT EXISTS incident_source_event_claims_incident_idx
        ON incident_source_event_claims(incident_id);
      CREATE INDEX IF NOT EXISTS ops_actions_turn_idx ON ops_actions(ops_turn_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS repair_runs_status_idx ON repair_runs(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS build_dispatches_queue_idx
        ON build_dispatches(status, created_at ASC, task_id, turn_sequence, id);
      CREATE INDEX IF NOT EXISTS build_dispatches_task_idx
        ON build_dispatches(task_id, created_at ASC);
    `);
    const buildDispatchColumns = this.db
      .prepare("PRAGMA table_info(build_dispatches)")
      .all();
    const buildDispatchMigrations = [
      [
        "build_status",
        "ALTER TABLE build_dispatches ADD COLUMN build_status TEXT",
      ],
      ["build_step", "ALTER TABLE build_dispatches ADD COLUMN build_step TEXT"],
      [
        "build_cdn_url",
        "ALTER TABLE build_dispatches ADD COLUMN build_cdn_url TEXT",
      ],
      [
        "build_error_message",
        "ALTER TABLE build_dispatches ADD COLUMN build_error_message TEXT",
      ],
      [
        "build_started_at",
        "ALTER TABLE build_dispatches ADD COLUMN build_started_at TEXT",
      ],
      [
        "build_finished_at",
        "ALTER TABLE build_dispatches ADD COLUMN build_finished_at TEXT",
      ],
      [
        "build_duration_seconds",
        "ALTER TABLE build_dispatches ADD COLUMN build_duration_seconds REAL",
      ],
      [
        "status_checked_at",
        "ALTER TABLE build_dispatches ADD COLUMN status_checked_at TEXT",
      ],
      [
        "next_status_check_at",
        "ALTER TABLE build_dispatches ADD COLUMN next_status_check_at TEXT",
      ],
      [
        "status_check_attempt_count",
        "ALTER TABLE build_dispatches ADD COLUMN status_check_attempt_count INTEGER NOT NULL DEFAULT 0",
      ],
      [
        "status_check_error_code",
        "ALTER TABLE build_dispatches ADD COLUMN status_check_error_code TEXT",
      ],
      [
        "status_check_error_message",
        "ALTER TABLE build_dispatches ADD COLUMN status_check_error_message TEXT",
      ],
    ];
    for (const [columnName, migration] of buildDispatchMigrations) {
      if (!buildDispatchColumns.some((column) => column.name === columnName)) {
        this.db.exec(migration);
      }
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS build_dispatches_status_check_idx ON build_dispatches(status, next_status_check_at ASC)",
    );
    this.db
      .prepare(
        `UPDATE build_dispatches
         SET build_status=COALESCE(build_status, 'queued'),
           next_status_check_at=COALESCE(next_status_check_at, accepted_at, updated_at)
         WHERE status='accepted'
           AND (build_status IS NULL OR build_status<>'completed')`,
      )
      .run();
    const projectColumns = this.db.prepare("PRAGMA table_info(projects)").all();
    if (!projectColumns.some((column) => column.name === "unity_health_url")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN unity_health_url TEXT");
    }
    const addedAutoBuild = !projectColumns.some(
      (column) => column.name === "auto_build_enabled",
    );
    const addedBuildProjectKey = !projectColumns.some(
      (column) => column.name === "build_project_key",
    );
    if (addedAutoBuild) {
      this.db.exec(
        "ALTER TABLE projects ADD COLUMN auto_build_enabled INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (addedBuildProjectKey) {
      this.db.exec("ALTER TABLE projects ADD COLUMN build_project_key TEXT");
    }
    if (addedAutoBuild || addedBuildProjectKey) {
      const repositoryUrl =
        this.config.ozdqpBuildRepositoryUrl ||
        "http://git.dominogm.com/diaoyu/ozdqp.git";
      this.db
        .prepare(
          `UPDATE projects
           SET auto_build_enabled=1, build_project_key='ozdqp'
           WHERE LOWER(RTRIM(repo_url, '/'))=LOWER(RTRIM(?, '/'))`,
        )
        .run(repositoryUrl);
    }
    const taskColumns = this.db.prepare("PRAGMA table_info(tasks)").all();
    if (!taskColumns.some((column) => column.name === "idempotency_key")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN idempotency_key TEXT");
    }
    if (!taskColumns.some((column) => column.name === "created_by")) {
      this.db.exec(
        "ALTER TABLE tasks ADD COLUMN created_by TEXT NOT NULL DEFAULT '未记录用户'",
      );
    }
    if (!taskColumns.some((column) => column.name === "codex_model")) {
      this.db.exec(
        `ALTER TABLE tasks ADD COLUMN codex_model TEXT NOT NULL DEFAULT '${DEFAULT_CODEX_MODEL}'`,
      );
    }
    if (
      !taskColumns.some((column) => column.name === "codex_reasoning_effort")
    ) {
      this.db.exec(
        `ALTER TABLE tasks ADD COLUMN codex_reasoning_effort TEXT NOT NULL DEFAULT '${DEFAULT_CODEX_REASONING_EFFORT}'`,
      );
    }
    const opsThreadColumns = this.db
      .prepare("PRAGMA table_info(ops_threads)")
      .all();
    if (!opsThreadColumns.some((column) => column.name === "title")) {
      this.db.exec(
        "ALTER TABLE ops_threads ADD COLUMN title TEXT NOT NULL DEFAULT 'New conversation'",
      );
    }
    if (!opsThreadColumns.some((column) => column.name === "is_system")) {
      this.db.exec(
        "ALTER TABLE ops_threads ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (
      !opsThreadColumns.some(
        (column) => column.name === "cleared_through_sequence",
      )
    ) {
      this.db.exec(
        "ALTER TABLE ops_threads ADD COLUMN cleared_through_sequence INTEGER NOT NULL DEFAULT 0",
      );
    }
    this.db
      .prepare(
        "UPDATE ops_threads SET title=?, is_system=1 WHERE id='ops-system'",
      )
      .run("系统自动恢复");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS ops_threads_activity_idx ON ops_threads(is_system DESC, updated_at DESC)",
    );
    if (!taskColumns.some((column) => column.name === "codex_fast_mode")) {
      this.db.exec(
        `ALTER TABLE tasks ADD COLUMN codex_fast_mode INTEGER NOT NULL DEFAULT ${DEFAULT_CODEX_FAST_MODE ? 1 : 0}`,
      );
    }
    const taskCompletionMigrations = [
      [
        "project_management_external_project_id",
        "ALTER TABLE tasks ADD COLUMN project_management_external_project_id TEXT",
      ],
      [
        "project_management_defect_id",
        "ALTER TABLE tasks ADD COLUMN project_management_defect_id TEXT",
      ],
      [
        "project_management_defect_url",
        "ALTER TABLE tasks ADD COLUMN project_management_defect_url TEXT",
      ],
      [
        "project_management_relay_user_name",
        "ALTER TABLE tasks ADD COLUMN project_management_relay_user_name TEXT",
      ],
      [
        "project_management_user_id",
        "ALTER TABLE tasks ADD COLUMN project_management_user_id TEXT",
      ],
      [
        "project_management_user_name",
        "ALTER TABLE tasks ADD COLUMN project_management_user_name TEXT",
      ],
      [
        "project_management_binding_key",
        "ALTER TABLE tasks ADD COLUMN project_management_binding_key TEXT",
      ],
      [
        "project_management_resolved_at",
        "ALTER TABLE tasks ADD COLUMN project_management_resolved_at TEXT",
      ],
      [
        "completion_status",
        "ALTER TABLE tasks ADD COLUMN completion_status TEXT NOT NULL DEFAULT 'idle'",
      ],
      ["completion_step", "ALTER TABLE tasks ADD COLUMN completion_step TEXT"],
      [
        "completion_error_code",
        "ALTER TABLE tasks ADD COLUMN completion_error_code TEXT",
      ],
      [
        "completion_error_message",
        "ALTER TABLE tasks ADD COLUMN completion_error_message TEXT",
      ],
      [
        "merge_request_iid",
        "ALTER TABLE tasks ADD COLUMN merge_request_iid INTEGER",
      ],
      [
        "merge_request_url",
        "ALTER TABLE tasks ADD COLUMN merge_request_url TEXT",
      ],
      [
        "merged_commit_sha",
        "ALTER TABLE tasks ADD COLUMN merged_commit_sha TEXT",
      ],
      [
        "completion_started_at",
        "ALTER TABLE tasks ADD COLUMN completion_started_at TEXT",
      ],
      [
        "completion_completed_at",
        "ALTER TABLE tasks ADD COLUMN completion_completed_at TEXT",
      ],
    ];
    for (const [columnName, migration] of taskCompletionMigrations) {
      if (!taskColumns.some((column) => column.name === columnName)) {
        this.db.exec(migration);
      }
    }
    const turnColumns = this.db.prepare("PRAGMA table_info(turns)").all();
    if (!turnColumns.some((column) => column.name === "author_name")) {
      this.db.exec(
        "ALTER TABLE turns ADD COLUMN author_name TEXT NOT NULL DEFAULT '未记录用户'",
      );
    }
    if (!turnColumns.some((column) => column.name === "execution_mode")) {
      this.db.exec(
        "ALTER TABLE turns ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'full'",
      );
    }
    if (!turnColumns.some((column) => column.name === "execution_profile")) {
      this.db.exec(
        "ALTER TABLE turns ADD COLUMN execution_profile TEXT NOT NULL DEFAULT 'auto'",
      );
    }
    if (!turnColumns.some((column) => column.name === "delivery_audit_json")) {
      this.db.exec("ALTER TABLE turns ADD COLUMN delivery_audit_json TEXT");
    }
    const opsTurnColumns = this.db
      .prepare("PRAGMA table_info(ops_turns)")
      .all();
    if (!opsTurnColumns.some((column) => column.name === "target_task_id")) {
      this.db.exec("ALTER TABLE ops_turns ADD COLUMN target_task_id TEXT");
    }
    if (
      !opsTurnColumns.some((column) => column.name === "parent_ops_turn_id")
    ) {
      this.db.exec("ALTER TABLE ops_turns ADD COLUMN parent_ops_turn_id TEXT");
    }
    const eventColumns = this.db.prepare("PRAGMA table_info(events)").all();
    if (!eventColumns.some((column) => column.name === "actor_name")) {
      this.db.exec("ALTER TABLE events ADD COLUMN actor_name TEXT");
    }
    if (!eventColumns.some((column) => column.name === "ops_turn_id")) {
      this.db.exec("ALTER TABLE events ADD COLUMN ops_turn_id TEXT");
    }
    if (!eventColumns.some((column) => column.name === "incident_id")) {
      this.db.exec("ALTER TABLE events ADD COLUMN incident_id TEXT");
    }
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS incident_source_event_claims (
          source_event_id TEXT PRIMARY KEY,
          incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE RESTRICT,
          auto_recovery_turn_id TEXT UNIQUE REFERENCES ops_turns(id) ON DELETE RESTRICT,
          claimed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS incident_source_event_claims_incident_idx
          ON incident_source_event_claims(incident_id);
      `);
      this.db.exec(`
        INSERT INTO incident_source_event_claims (
          source_event_id, incident_id, auto_recovery_turn_id, claimed_at
        )
        SELECT
          CAST(candidate.source_event_id AS TEXT),
          candidate.id,
          (
            SELECT candidate_turn.id
            FROM ops_turns AS candidate_turn
            JOIN incidents AS turn_incident
              ON turn_incident.id=candidate_turn.incident_id
            WHERE candidate_turn.trigger='incident'
              AND CAST(turn_incident.source_event_id AS TEXT)
                = CAST(candidate.source_event_id AS TEXT)
            ORDER BY candidate_turn.created_at ASC,
              candidate_turn.sequence ASC, candidate_turn.id ASC
            LIMIT 1
          ),
          candidate.created_at
        FROM incidents AS candidate
        WHERE candidate.source_event_id IS NOT NULL
          AND LENGTH(TRIM(CAST(candidate.source_event_id AS TEXT))) > 0
          AND NOT EXISTS (
            SELECT 1
            FROM incidents AS earlier
            WHERE CAST(earlier.source_event_id AS TEXT)
                = CAST(candidate.source_event_id AS TEXT)
              AND (
                earlier.created_at < candidate.created_at
                OR (
                  earlier.created_at = candidate.created_at
                  AND earlier.id < candidate.id
                )
              )
          )
        ON CONFLICT(source_event_id) DO NOTHING
      `);
    });
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency_idx
      ON tasks(idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);
    this.db.exec(`
      UPDATE projects
      SET unity_health_url = unity_skill_url
      WHERE unity_health_url IS NULL AND unity_skill_url LIKE '%/health'
    `);
    for (const turn of this.db
      .prepare("SELECT id FROM turns ORDER BY created_at ASC")
      .all()) {
      this.archiveTaskPrompt(turn.id);
    }
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS task_prompt_archive_no_update
      BEFORE UPDATE ON task_prompt_archive
      BEGIN
        SELECT RAISE(ABORT, 'TASK_PROMPT_ARCHIVE_IMMUTABLE');
      END;
      CREATE TRIGGER IF NOT EXISTS task_prompt_archive_no_delete
      BEFORE DELETE ON task_prompt_archive
      BEGIN
        SELECT RAISE(ABORT, 'TASK_PROMPT_ARCHIVE_IMMUTABLE');
      END;
      CREATE TRIGGER IF NOT EXISTS turns_user_message_immutable
      BEFORE UPDATE OF user_message ON turns
      WHEN OLD.user_message IS NOT NEW.user_message
      BEGIN
        SELECT RAISE(ABORT, 'TASK_PROMPT_IMMUTABLE');
      END;
      CREATE TRIGGER IF NOT EXISTS turns_prompt_no_delete
      BEFORE DELETE ON turns
      BEGIN
        SELECT RAISE(ABORT, 'TASK_PROMPT_IMMUTABLE');
      END;
      CREATE TRIGGER IF NOT EXISTS tasks_prompt_no_delete
      BEFORE DELETE ON tasks
      BEGIN
        SELECT RAISE(ABORT, 'TASK_PROMPT_IMMUTABLE');
      END;
      CREATE TRIGGER IF NOT EXISTS tasks_title_immutable
      BEFORE UPDATE OF title ON tasks
      WHEN OLD.title IS NOT NEW.title
      BEGIN
        SELECT RAISE(ABORT, 'TASK_PROMPT_IMMUTABLE');
      END;
    `);
  }

  reconcileInterruptedWork() {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE tasks SET completion_status='failed',
          completion_error_code='SERVER_RESTARTED_DURING_COMPLETION',
          completion_error_message='Relay restarted during confirmation; retry resumes from verified completed steps',
          updated_at=? WHERE completion_status='running'`,
      )
      .run(timestamp);
    this.db
      .prepare(
        `UPDATE build_dispatches
         SET status='retrying', next_attempt_at=?, updated_at=?,
           last_error_code='RELAY_RESTARTED_DURING_DISPATCH',
           last_error_message='Relay restarted while the request was in flight'
         WHERE status='sending'`,
      )
      .run(timestamp, timestamp);
    const active = this.db
      .prepare(
        `
      SELECT id, task_id, worker_id FROM turns
      WHERE status IN ('preparing', 'running', 'saving', 'cancel_requested')
    `,
      )
      .all();
    if (active.length > 0) {
      this.transaction(() => {
        for (const turn of active) {
          this.db
            .prepare(
              `
          UPDATE turns SET status='interrupted', error_code='SERVER_RESTARTED',
            error_message='Backend restarted while this turn was active', finished_at=?
          WHERE id=?
        `,
            )
            .run(timestamp, turn.id);
          const queued = this.db
            .prepare(
              "SELECT id FROM turns WHERE task_id=? AND status='queued' ORDER BY sequence LIMIT 1",
            )
            .get(turn.task_id);
          this.db
            .prepare(`UPDATE tasks SET status=?, updated_at=? WHERE id=?`)
            .run(queued ? "queued" : "failed", timestamp, turn.task_id);
          if (turn.worker_id) {
            if (queued) {
              this.db
                .prepare(
                  "UPDATE turns SET worker_id=? WHERE id=? AND worker_id IS NULL",
                )
                .run(turn.worker_id, queued.id);
            }
            this.db
              .prepare(
                `
            UPDATE workers SET status='attention', current_turn_id=NULL,
              last_error='Backend restarted during active work; inspect preserved workspace', updated_at=?
            WHERE id=?
          `,
              )
              .run(timestamp, turn.worker_id);
          }
        }
      });
    }
    this.db.exec(`
      UPDATE ops_turns
      SET status='interrupted', error_code='SERVER_RESTARTED',
        error_message='Relay restarted while this Ops turn was active',
        finished_at='${timestamp}'
      WHERE status='running' AND trigger<>'repair';
      UPDATE ops_turns
      SET status='queued', error_code=NULL,
        error_message='Relay restarted; the unrestricted recovery conversation will resume',
        started_at=NULL, finished_at=NULL
      WHERE status='running' AND trigger='repair';
      UPDATE incidents
      SET status='open', updated_at='${timestamp}'
      WHERE status IN ('diagnosing','acting');
      UPDATE repair_runs
      SET status='interrupted', error='Relay restarted while repair was active',
        updated_at='${timestamp}'
      WHERE status IN ('running','validating','deploying');
      UPDATE ops_threads
      SET status=CASE
        WHEN EXISTS (
          SELECT 1 FROM ops_turns
          WHERE ops_turns.thread_id=ops_threads.id
            AND ops_turns.status='queued'
        ) THEN 'queued'
        ELSE 'idle'
      END,
      updated_at='${timestamp}'
      WHERE status IN ('running','queued');
    `);
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDurableEvent(listener) {
    this.durableEventSinks.add(listener);
    return () => this.durableEventSinks.delete(listener);
  }

  insertEvent({
    taskId = null,
    turnId = null,
    workerId = null,
    opsTurnId = null,
    incidentId = null,
    actorName = null,
    level = "info",
    type,
    phase = null,
    message,
    data = null,
  }) {
    const createdAt = now();
    const result = this.db
      .prepare(
        `
      INSERT INTO events (
        task_id, turn_id, worker_id, ops_turn_id, incident_id, actor_name,
        level, type, phase, message, data_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        taskId,
        turnId,
        workerId,
        opsTurnId,
        incidentId,
        actorName,
        level,
        type,
        phase,
        message,
        stringifyJson(data),
        createdAt,
      );
    const event = {
      id: Number(result.lastInsertRowid),
      taskId,
      turnId,
      workerId,
      opsTurnId,
      incidentId,
      actorName,
      level,
      type,
      phase,
      message,
      data,
      createdAt,
    };
    // Durable sinks write through this same SQLite connection. When the source
    // event is inside a Store transaction, their outbox row commits or rolls
    // back with it; failures intentionally propagate instead of losing facts.
    for (const sink of this.durableEventSinks) sink(event);
    return event;
  }

  notifyEvent(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* disconnected listener */
      }
    }
  }

  emit(input) {
    const event = this.insertEvent(input);
    this.notifyEvent(event);
    return event;
  }

  listEvents({ afterId = 0, limit = 150 } = {}) {
    return this.db
      .prepare(
        `
      SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?
    `,
      )
      .all(afterId, limit)
      .reverse()
      .map(eventFromRow);
  }

  listTaskEvents(taskId) {
    return this.db
      .prepare(
        `
      SELECT * FROM events WHERE task_id=? ORDER BY id ASC
    `,
      )
      .all(taskId)
      .map(eventFromRow);
  }

  listProjects() {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY name")
      .all()
      .map(projectFromRow);
  }

  getProject(projectId) {
    return projectFromRow(
      this.db.prepare("SELECT * FROM projects WHERE id=?").get(projectId),
    );
  }

  createProject(input, actorName = null) {
    const projectId = input.id || id("project-");
    const timestamp = now();
    this.db
      .prepare(
        `
      INSERT INTO projects (
        id, name, repo_url, default_branch, guest_project_path, smb_path,
        unity_version, unity_skill_url, unity_health_url, unity_save_url, checkpoint_name, enabled,
        auto_build_enabled, build_project_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        projectId,
        input.name,
        input.repoUrl,
        input.defaultBranch || "main",
        input.guestProjectPath,
        input.smbPath,
        input.unityVersion || null,
        input.unitySkillUrl || null,
        input.unityHealthUrl || null,
        input.unitySaveUrl || null,
        input.checkpointName || "PROJECT_READY",
        input.enabled === false ? 0 : 1,
        input.autoBuildEnabled === true ? 1 : 0,
        input.buildProjectKey || null,
        timestamp,
        timestamp,
      );
    const project = this.getProject(projectId);
    this.emit({
      actorName,
      type: "project.created",
      message: `Project ${project.name} created`,
      data: { projectId },
    });
    return project;
  }

  updateProject(projectId, changes, actorName = null) {
    if (!this.getProject(projectId))
      throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found");
    const entries = Object.entries(PROJECT_FIELDS).filter(([key]) =>
      Object.hasOwn(changes, key),
    );
    if (entries.length === 0) return this.getProject(projectId);
    const assignments = entries.map(([, column]) => `${column}=?`);
    const values = entries.map(([key]) =>
      ["enabled", "autoBuildEnabled"].includes(key)
        ? changes[key]
          ? 1
          : 0
        : changes[key],
    );
    values.push(now(), projectId);
    this.db
      .prepare(
        `UPDATE projects SET ${assignments.join(", ")}, updated_at=? WHERE id=?`,
      )
      .run(...values);
    const project = this.getProject(projectId);
    this.emit({
      actorName,
      type: "project.updated",
      message: `Project ${project.name} updated`,
      data: { projectId },
    });
    return project;
  }

  deleteProject(projectId, actorName = null) {
    const project = this.getProject(projectId);
    if (!project)
      throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found");
    const references = this.db
      .prepare(
        `
      SELECT (SELECT COUNT(*) FROM workers WHERE project_id=?) +
             (SELECT COUNT(*) FROM tasks WHERE project_id=?) AS count
    `,
      )
      .get(projectId, projectId).count;
    if (references > 0)
      throw new HttpError(
        409,
        "PROJECT_IN_USE",
        "Project still has workers or task history",
      );
    this.db.prepare("DELETE FROM projects WHERE id=?").run(projectId);
    this.emit({
      actorName,
      type: "project.deleted",
      message: `Project ${project.name} deleted`,
      data: { projectId },
    });
  }

  listWorkers() {
    return this.db
      .prepare("SELECT * FROM workers ORDER BY name")
      .all()
      .map(workerFromRow);
  }

  getWorker(workerId) {
    return workerFromRow(
      this.db.prepare("SELECT * FROM workers WHERE id=?").get(workerId),
    );
  }

  createWorker(input, actorName = null) {
    if (input.projectId && !this.getProject(input.projectId)) {
      throw new HttpError(
        400,
        "PROJECT_NOT_FOUND",
        "Configured project does not exist",
      );
    }
    const workerId = input.id || id("worker-");
    const timestamp = now();
    this.db
      .prepare(
        `
      INSERT INTO workers (
        id, name, vm_name, project_id, checkpoint_name, internal_ip, corporate_ip,
        share_path, credential_path, status, enabled, health_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        workerId,
        input.name,
        input.vmName || input.name,
        input.projectId || null,
        input.checkpointName || "PROJECT_READY",
        input.internalIp || null,
        input.corporateIp || null,
        input.sharePath,
        input.credentialPath || null,
        input.status || "stopped",
        input.enabled === false ? 0 : 1,
        stringifyJson({
          vm: false,
          heartbeat: false,
          smb: false,
          unity: false,
          skill: null,
          dialogGuard: null,
        }),
        timestamp,
        timestamp,
      );
    const worker = this.getWorker(workerId);
    this.emit({
      workerId,
      actorName,
      type: "worker.created",
      message: `Worker ${worker.name} created`,
    });
    return worker;
  }

  updateWorker(workerId, changes, actorName = null) {
    const existing = this.getWorker(workerId);
    if (!existing)
      throw new HttpError(404, "WORKER_NOT_FOUND", "Worker not found");
    if (changes.projectId && !this.getProject(changes.projectId)) {
      throw new HttpError(
        400,
        "PROJECT_NOT_FOUND",
        "Configured project does not exist",
      );
    }
    const entries = Object.entries(WORKER_FIELDS).filter(([key]) =>
      Object.hasOwn(changes, key),
    );
    if (entries.length === 0) return existing;
    const assignments = entries.map(([, column]) => `${column}=?`);
    const values = entries.map(([key]) =>
      key === "enabled" ? (changes[key] ? 1 : 0) : changes[key],
    );
    values.push(now(), workerId);
    this.db
      .prepare(
        `UPDATE workers SET ${assignments.join(", ")}, updated_at=? WHERE id=?`,
      )
      .run(...values);
    const worker = this.getWorker(workerId);
    this.emit({
      workerId,
      actorName,
      type: "worker.updated",
      message: `Worker ${worker.name} updated`,
    });
    return worker;
  }

  deleteWorker(workerId, actorName = null) {
    const worker = this.getWorker(workerId);
    if (!worker)
      throw new HttpError(404, "WORKER_NOT_FOUND", "Worker not found");
    if (worker.currentTurnId || worker.status === "busy") {
      throw new HttpError(
        409,
        "WORKER_BUSY",
        "A busy worker cannot be deleted",
      );
    }
    this.db.prepare("DELETE FROM workers WHERE id=?").run(workerId);
    this.emit({
      actorName,
      type: "worker.deleted",
      message: `Worker ${worker.name} deleted`,
      data: { workerId },
    });
  }

  updateWorkerHealth(workerId, health) {
    const worker = this.getWorker(workerId);
    if (!worker) return null;
    const timestamp = now();
    let nextStatus = worker.status;
    if (
      !worker.currentTurnId &&
      !["attention", "preparing"].includes(worker.status)
    ) {
      nextStatus =
        health.vm === false
          ? "stopped"
          : health.ready === false || health.unity === false
            ? "offline"
            : "ready";
    }
    this.db
      .prepare(
        `
      UPDATE workers SET health_json=?, last_seen_at=?, status=?, last_error=?, updated_at=? WHERE id=?
    `,
      )
      .run(
        stringifyJson({ ...health, checkedAt: timestamp }),
        timestamp,
        nextStatus,
        health.error || (nextStatus === "ready" ? null : worker.lastError),
        timestamp,
        workerId,
      );
    return this.getWorker(workerId);
  }

  setWorkerState(
    workerId,
    status,
    { currentTurnId = undefined, error = undefined } = {},
  ) {
    const worker = this.getWorker(workerId);
    if (!worker)
      throw new HttpError(404, "WORKER_NOT_FOUND", "Worker not found");
    const assignments = ["status=?", "updated_at=?"];
    const values = [status, now()];
    if (currentTurnId !== undefined) {
      assignments.push("current_turn_id=?");
      values.push(currentTurnId);
    }
    if (error !== undefined) {
      assignments.push("last_error=?");
      values.push(error);
    }
    values.push(workerId);
    this.db
      .prepare(`UPDATE workers SET ${assignments.join(", ")} WHERE id=?`)
      .run(...values);
    return this.getWorker(workerId);
  }

  getTaskWorkload() {
    const row = this.db
      .prepare(
        `
        SELECT
          COALESCE(SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END), 0) AS queued_turns,
          COALESCE(SUM(CASE WHEN status IN ('preparing','running','saving','cancel_requested') THEN 1 ELSE 0 END), 0) AS executing_turns
        FROM turns
        WHERE status IN ('queued','preparing','running','saving','cancel_requested')
      `,
      )
      .get();
    const queuedTurns = Number(row?.queued_turns || 0);
    const executingTurns = Number(row?.executing_turns || 0);
    return {
      queuedTurns,
      executingTurns,
      totalTurns: queuedTurns + executingTurns,
    };
  }

  reserveWorkerForCheckpointMaintenance(workerId) {
    return this.transaction(() => {
      const workload = this.getTaskWorkload();
      if (workload.totalTurns > 0) {
        return {
          reserved: false,
          code: "CHECKPOINT_MAINTENANCE_TASK_QUEUE_NOT_EMPTY",
          workload,
          worker: this.getWorker(workerId),
        };
      }

      const reserved = this.db
        .prepare(
          `
          UPDATE workers
          SET status='preparing', current_turn_id=NULL, last_error=NULL, updated_at=?
          WHERE id=? AND enabled=1 AND status='ready' AND current_turn_id IS NULL
        `,
        )
        .run(now(), workerId);
      return {
        reserved: reserved.changes === 1,
        code:
          reserved.changes === 1
            ? null
            : "CHECKPOINT_MAINTENANCE_WORKER_NOT_IDLE",
        workload,
        worker: this.getWorker(workerId),
      };
    });
  }

  createTask(input) {
    const project = this.getProject(input.projectId);
    if (!project || !project.enabled)
      throw new HttpError(
        400,
        "PROJECT_NOT_AVAILABLE",
        "Project is not available",
      );
    const idempotencyKey = input.idempotencyKey || null;
    if (idempotencyKey) {
      const existing = this.db
        .prepare("SELECT * FROM tasks WHERE idempotency_key=?")
        .get(idempotencyKey);
      if (existing) {
        const task = taskFromRow(existing);
        const turn = turnFromRow(
          this.db
            .prepare(
              "SELECT * FROM turns WHERE task_id=? ORDER BY sequence LIMIT 1",
            )
            .get(task.id),
        );
        return { task, turn, duplicate: true };
      }
    }
    const timestamp = now();
    return this.transaction(() => {
      const taskNumber = Number(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(task_number), 0) + 1 AS value FROM tasks",
          )
          .get().value,
      );
      const taskId = id("task-");
      const turnId = id("turn-");
      const baseBranch = input.baseBranch || project.defaultBranch;
      const branchName =
        input.branchName ||
        `codex/task-${String(taskNumber).padStart(4, "0")}-${slug(input.title)}`;
      const priority = Number(input.priority || 0);
      const codexModel = input.codexModel || DEFAULT_CODEX_MODEL;
      const codexReasoningEffort =
        input.codexReasoningEffort || DEFAULT_CODEX_REASONING_EFFORT;
      const codexFastMode =
        (input.codexFastMode ?? DEFAULT_CODEX_FAST_MODE) ? 1 : 0;
      const turnExecutionProfile = executionProfile(input.executionProfile);
      const projectManagement = input.projectManagement || null;
      this.db
        .prepare(
          `
        INSERT INTO tasks (
          id, task_number, idempotency_key, title, created_by, project_id, base_branch, branch_name, status,
          priority, auto_release, codex_model, codex_reasoning_effort, codex_fast_mode,
          project_management_external_project_id, project_management_defect_id,
          project_management_defect_url, project_management_relay_user_name,
          project_management_user_id, project_management_user_name,
          project_management_binding_key,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          taskId,
          taskNumber,
          idempotencyKey,
          input.title,
          input.userName || "未记录用户",
          input.projectId,
          baseBranch,
          branchName,
          priority,
          input.autoRelease === false ? 0 : 1,
          codexModel,
          codexReasoningEffort,
          codexFastMode,
          projectManagement?.externalProjectId || null,
          projectManagement?.defectId || null,
          projectManagement?.defectUrl || null,
          projectManagement?.relayUserName || null,
          projectManagement?.userId || null,
          projectManagement?.userName || null,
          projectManagement?.bindingKey || null,
          timestamp,
          timestamp,
        );
      this.db
        .prepare(
          `
        INSERT INTO turns (
          id, task_id, sequence, user_message, author_name, status, priority, execution_profile, created_at
        )
        VALUES (?, ?, 1, ?, ?, 'queued', ?, ?, ?)
      `,
        )
        .run(
          turnId,
          taskId,
          input.message,
          input.userName || "未记录用户",
          priority,
          turnExecutionProfile,
          timestamp,
        );
      this.attachUploads(input.attachments, taskId, turnId);
      for (const attachment of input.preparedAttachments || []) {
        this.createAttachment({ ...attachment, taskId, turnId });
      }
      this.archiveTaskPrompt(turnId);
      const task = this.getTask(taskId);
      const turn = this.getTurn(turnId);
      input.onCreatedInTransaction?.({ task, turn });
      queueMicrotask(() =>
        this.emit({
          taskId,
          turnId,
          actorName: input.userName || null,
          type: "turn.queued",
          phase: "queue",
          message: `Task #${taskNumber} entered the execution queue`,
          data: { position: this.queuePosition(turnId) },
        }),
      );
      return { task, turn };
    });
  }

  getTask(taskId) {
    return taskFromRow(
      this.db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId),
    );
  }

  getTaskByIdempotencyKey(idempotencyKey) {
    if (!idempotencyKey) return null;
    return taskFromRow(
      this.db
        .prepare("SELECT * FROM tasks WHERE idempotency_key=?")
        .get(idempotencyKey),
    );
  }

  linkProjectManagementTask(taskId, link, actorName = null) {
    const task = this.getTask(taskId);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    const existing = this.getTaskProjectManagementLink(taskId);
    if (
      existing &&
      (existing.defectId !== String(link.defectId) ||
        existing.externalProjectId !== String(link.externalProjectId))
    ) {
      throw new HttpError(
        409,
        "PROJECT_MANAGEMENT_TASK_LINK_CONFLICT",
        "Task is already linked to a different project-management defect",
      );
    }
    if (
      existing?.bindingKey &&
      (existing.bindingKey !== link.bindingKey || existing.userId)
    ) {
      return task;
    }
    this.db
      .prepare(
        `UPDATE tasks SET project_management_external_project_id=?,
          project_management_defect_id=?, project_management_defect_url=?,
          project_management_relay_user_name=?, project_management_user_id=?,
          project_management_user_name=?, project_management_binding_key=?,
          updated_at=? WHERE id=?`,
      )
      .run(
        String(link.externalProjectId),
        String(link.defectId),
        link.defectUrl || null,
        link.relayUserName || null,
        link.userId || null,
        link.userName || null,
        link.bindingKey || null,
        now(),
        taskId,
      );
    if (!existing) {
      this.emit({
        taskId,
        actorName,
        type: "task.project-management.linked",
        phase: "created",
        message: `Task #${task.number} linked to project-management defect ${link.defectId}`,
        data: {
          externalProjectId: String(link.externalProjectId),
          defectId: String(link.defectId),
          defectUrl: link.defectUrl || null,
        },
      });
    }
    return this.getTask(taskId);
  }

  listTasks() {
    return this.db
      .prepare("SELECT * FROM tasks ORDER BY updated_at DESC")
      .all()
      .map(taskFromRow);
  }

  getTurn(turnId) {
    return turnFromRow(
      this.db.prepare("SELECT * FROM turns WHERE id=?").get(turnId),
    );
  }

  withTurnAttachments(turns, attachments) {
    const attachmentsByTurn = new Map();
    for (const attachment of attachments) {
      const collection = attachmentsByTurn.get(attachment.turnId) || [];
      collection.push({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        createdAt: attachment.createdAt,
      });
      attachmentsByTurn.set(attachment.turnId, collection);
    }
    return turns.map((turn) => ({
      ...turn,
      attachments: attachmentsByTurn.get(turn.id) || [],
    }));
  }

  listTurns() {
    return this.db
      .prepare("SELECT * FROM turns ORDER BY created_at DESC")
      .all()
      .map(turnFromRow);
  }

  listTurnsWithAttachments() {
    const turns = this.listTurns();
    const attachments = this.db
      .prepare(
        "SELECT * FROM attachments WHERE turn_id IS NOT NULL ORDER BY created_at",
      )
      .all()
      .map(attachmentFromRow);
    return this.withTurnAttachments(turns, attachments);
  }

  listTaskTurns(taskId) {
    return this.db
      .prepare("SELECT * FROM turns WHERE task_id=? ORDER BY sequence")
      .all(taskId)
      .map(turnFromRow);
  }

  listTaskTurnsWithAttachments(taskId) {
    const turns = this.listTaskTurns(taskId);
    const attachments = this.db
      .prepare(
        "SELECT * FROM attachments WHERE task_id=? AND turn_id IS NOT NULL ORDER BY created_at",
      )
      .all(taskId)
      .map(attachmentFromRow);
    return this.withTurnAttachments(turns, attachments);
  }

  hasActiveTurn(taskId) {
    const placeholders = ACTIVE_TURN_STATUSES.map(() => "?").join(",");
    return Boolean(
      this.db
        .prepare(
          `
      SELECT 1 FROM turns WHERE task_id=? AND status IN (${placeholders}) LIMIT 1
    `,
        )
        .get(taskId, ...ACTIVE_TURN_STATUSES),
    );
  }

  appendTurn(taskId, input) {
    const task = this.getTask(taskId);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    const timestamp = now();
    const turnId = id("turn-");
    return this.transaction(() => {
      const executingPlaceholders = EXECUTING_TURN_STATUSES.map(() => "?").join(
        ",",
      );
      const executing = this.db
        .prepare(
          `SELECT 1 FROM turns WHERE task_id=? AND status IN (${executingPlaceholders}) LIMIT 1`,
        )
        .get(taskId, ...EXECUTING_TURN_STATUSES);
      const queued = this.db
        .prepare(
          "SELECT 1 FROM turns WHERE task_id=? AND status='queued' LIMIT 1",
        )
        .get(taskId);
      let preservedWorkerId = null;
      if (!executing && !queued) {
        const preserved = this.db
          .prepare(
            `
            SELECT turns.worker_id
            FROM turns
            JOIN workers ON workers.id=turns.worker_id
            WHERE turns.task_id=?
              AND turns.status IN ('failed','cancelled','interrupted')
              AND workers.status='attention'
            ORDER BY turns.sequence DESC
            LIMIT 1
          `,
          )
          .get(taskId);
        preservedWorkerId = preserved?.worker_id || null;
      }
      const sequence = Number(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM turns WHERE task_id=?",
          )
          .get(taskId).value,
      );
      const priority = input.priority ?? task.priority;
      const turnExecutionProfile = executionProfile(input.executionProfile);
      this.db
        .prepare(
          `
        INSERT INTO turns (
          id, task_id, sequence, user_message, author_name, status, priority, worker_id, execution_profile, created_at
        )
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
      `,
        )
        .run(
          turnId,
          taskId,
          sequence,
          input.message,
          input.userName || "未记录用户",
          priority,
          preservedWorkerId,
          turnExecutionProfile,
          timestamp,
        );
      this.db
        .prepare(
          `UPDATE tasks SET status=?, priority=?, closed_at=NULL,
            completion_status='idle', completion_step=NULL,
            completion_error_code=NULL, completion_error_message=NULL,
            merge_request_iid=NULL, merge_request_url=NULL,
            merged_commit_sha=NULL, completion_started_at=NULL,
            completion_completed_at=NULL, updated_at=? WHERE id=?`,
        )
        .run(executing ? "running" : "queued", priority, timestamp, taskId);
      this.attachUploads(input.attachments, taskId, turnId);
      for (const attachment of input.preparedAttachments || []) {
        this.createAttachment({ ...attachment, taskId, turnId });
      }
      this.archiveTaskPrompt(turnId);
      const turn = this.getTurn(turnId);
      input.onCreatedInTransaction?.({ task: this.getTask(taskId), turn });
      queueMicrotask(() =>
        this.emit({
          taskId,
          turnId,
          actorName: input.userName || null,
          type: "turn.queued",
          phase: "queue",
          message: `Turn ${sequence} entered the execution queue`,
          data: {
            position: this.queuePosition(turnId),
            preservedWorkspace: Boolean(preservedWorkerId),
          },
        }),
      );
      return turn;
    });
  }

  attachUploads(attachmentIds, taskId, turnId) {
    if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) return;
    const statement = this.db.prepare(`
      UPDATE attachments SET task_id=?, turn_id=? WHERE id=? AND task_id IS NULL AND turn_id IS NULL
    `);
    for (const attachmentId of attachmentIds)
      statement.run(taskId, turnId, String(attachmentId));
  }

  createAttachment({
    filename,
    path,
    contentType,
    size,
    taskId = null,
    turnId = null,
  }) {
    if (taskId && !this.getTask(taskId))
      throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    if (turnId && !this.getTurn(turnId))
      throw new HttpError(404, "TURN_NOT_FOUND", "Turn not found");
    const attachmentId = id("file-");
    this.db
      .prepare(
        `
      INSERT INTO attachments (id, task_id, turn_id, filename, path, content_type, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        attachmentId,
        taskId,
        turnId,
        filename,
        path,
        contentType,
        size,
        now(),
      );
    return attachmentFromRow(
      this.db.prepare("SELECT * FROM attachments WHERE id=?").get(attachmentId),
    );
  }

  getAttachment(attachmentId) {
    return attachmentFromRow(
      this.db.prepare("SELECT * FROM attachments WHERE id=?").get(attachmentId),
    );
  }

  listTurnAttachments(turnId) {
    return this.db
      .prepare("SELECT * FROM attachments WHERE turn_id=? ORDER BY created_at")
      .all(turnId)
      .map(attachmentFromRow);
  }

  archiveTaskPrompt(turnId) {
    const row = this.db
      .prepare(
        `
        SELECT turns.id AS turn_id, turns.task_id, tasks.task_number,
          tasks.title AS task_title, turns.sequence, turns.author_name,
          turns.user_message, turns.created_at AS turn_created_at
        FROM turns
        JOIN tasks ON tasks.id=turns.task_id
        WHERE turns.id=?
      `,
      )
      .get(turnId);
    if (!row) return null;
    const attachments = this.listTurnAttachments(turnId).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      path: attachment.path,
      contentType: attachment.contentType,
      size: attachment.size,
    }));
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO task_prompt_archive (
          turn_id, task_id, task_number, task_title, sequence, author_name,
          user_message, attachments_json, turn_created_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        row.turn_id,
        row.task_id,
        row.task_number,
        row.task_title,
        row.sequence,
        row.author_name,
        row.user_message,
        stringifyJson(attachments),
        row.turn_created_at,
        now(),
      );
    return this.db
      .prepare("SELECT * FROM task_prompt_archive WHERE turn_id=?")
      .get(turnId);
  }

  getTaskPromptArchive(taskId) {
    return this.db
      .prepare(
        `
        SELECT * FROM task_prompt_archive
        WHERE task_id=?
        ORDER BY sequence ASC, turn_created_at ASC
      `,
      )
      .all(taskId)
      .map((row) => ({
        turnId: row.turn_id,
        taskId: row.task_id,
        taskNumber: Number(row.task_number),
        taskTitle: row.task_title,
        sequence: Number(row.sequence),
        authorName: row.author_name,
        userMessage: row.user_message,
        attachments: parseJson(row.attachments_json, []),
        turnCreatedAt: row.turn_created_at,
        archivedAt: row.archived_at,
      }));
  }

  taskPromptFingerprint(taskId) {
    const archive = this.getTaskPromptArchive(taskId);
    return createHash("sha256")
      .update(JSON.stringify(archive), "utf8")
      .digest("hex");
  }

  verifyTaskPromptIntegrity(taskId) {
    const archive = this.getTaskPromptArchive(taskId);
    const live = this.db
      .prepare(
        `
        SELECT turns.id AS turn_id, turns.sequence, turns.author_name,
          turns.user_message, tasks.title AS task_title
        FROM turns
        JOIN tasks ON tasks.id=turns.task_id
        WHERE turns.task_id=?
        ORDER BY turns.sequence ASC
      `,
      )
      .all(taskId);
    const intact =
      archive.length === live.length &&
      archive.every((entry, index) => {
        const current = live[index];
        return (
          current &&
          entry.turnId === current.turn_id &&
          entry.sequence === Number(current.sequence) &&
          entry.authorName === current.author_name &&
          entry.userMessage === current.user_message &&
          entry.taskTitle === current.task_title
        );
      });
    return {
      intact,
      taskId,
      fingerprint: this.taskPromptFingerprint(taskId),
      archivedTurns: archive.length,
      liveTurns: live.length,
      archive,
    };
  }

  queuePosition(turnId) {
    const queued = this.db
      .prepare(
        `
      SELECT id FROM turns WHERE status='queued' ORDER BY priority DESC, created_at ASC
    `,
      )
      .all();
    const index = queued.findIndex((item) => item.id === turnId);
    return index < 0 ? null : index + 1;
  }

  reserveStoppedWorkerForQueuedTurn() {
    return this.transaction(() => {
      const workerRow = this.db
        .prepare(
          `
        SELECT workers.*
        FROM turns
        JOIN tasks ON tasks.id=turns.task_id
        JOIN workers
          ON (workers.project_id=tasks.project_id OR workers.project_id IS NULL)
         AND (turns.worker_id IS NULL OR turns.worker_id=workers.id)
        WHERE turns.status='queued' AND tasks.status='queued'
          AND workers.enabled=1 AND workers.status='stopped'
          AND workers.current_turn_id IS NULL
        ORDER BY turns.priority DESC, turns.created_at ASC,
          CASE WHEN workers.project_id=tasks.project_id THEN 0 ELSE 1 END,
          workers.name
        LIMIT 1
      `,
        )
        .get();
      if (!workerRow) return null;
      const reserved = this.db
        .prepare(
          `
        UPDATE workers SET status='preparing', last_error=NULL, updated_at=?
        WHERE id=? AND enabled=1 AND status='stopped' AND current_turn_id IS NULL
      `,
        )
        .run(now(), workerRow.id);
      return reserved.changes ? this.getWorker(workerRow.id) : null;
    });
  }

  claimNextTurn() {
    return this.transaction(() => {
      const candidates = this.db
        .prepare(
          `
        SELECT turns.*, tasks.project_id
        FROM turns JOIN tasks ON tasks.id=turns.task_id
        WHERE turns.status='queued' AND tasks.status='queued'
        ORDER BY turns.priority DESC, turns.created_at ASC
      `,
        )
        .all();
      for (const candidate of candidates) {
        const resumesPreservedWorkspace = Boolean(candidate.worker_id);
        const workerRow = resumesPreservedWorkspace
          ? this.db
              .prepare(
                `
                SELECT * FROM workers
                WHERE id=? AND enabled=1 AND current_turn_id IS NULL
                  AND status IN ('attention','ready','reserved')
                  AND (project_id=? OR project_id IS NULL)
                LIMIT 1
              `,
              )
              .get(candidate.worker_id, candidate.project_id)
          : this.db
              .prepare(
                `
                SELECT * FROM workers
                WHERE enabled=1 AND status='ready' AND current_turn_id IS NULL
                  AND (project_id=? OR project_id IS NULL)
                ORDER BY CASE WHEN project_id=? THEN 0 ELSE 1 END, name
                LIMIT 1
              `,
              )
              .get(candidate.project_id, candidate.project_id);
        if (!workerRow) continue;
        const timestamp = now();
        const turnUpdate = this.db
          .prepare(
            `
          UPDATE turns SET status='preparing', worker_id=?, started_at=? WHERE id=? AND status='queued'
        `,
          )
          .run(workerRow.id, timestamp, candidate.id);
        if (!turnUpdate.changes) continue;
        this.db
          .prepare(
            `
          UPDATE workers SET status='busy', current_turn_id=?, last_error=NULL, updated_at=?
          WHERE id=? AND status IN ('attention','ready','reserved')
            AND current_turn_id IS NULL
        `,
          )
          .run(candidate.id, timestamp, workerRow.id);
        this.db
          .prepare(`UPDATE tasks SET status='running', updated_at=? WHERE id=?`)
          .run(timestamp, candidate.task_id);
        return {
          ...this.getExecutionContext(candidate.id),
          resumePreservedWorkspace:
            resumesPreservedWorkspace &&
            (candidate.execution_mode || "full") !== "delivery_only",
          deliveryOnlyRetry:
            (candidate.execution_mode || "full") === "delivery_only",
        };
      }
      return null;
    });
  }

  getExecutionContext(turnId) {
    const turn = this.getTurn(turnId);
    if (!turn) return null;
    const task = this.getTask(turn.taskId);
    const worker = turn.workerId ? this.getWorker(turn.workerId) : null;
    const project = task ? this.getProject(task.projectId) : null;
    const attachments = this.listTurnAttachments(turnId);
    const workspaceEstablished = Boolean(
      task?.codexThreadId ||
      this.db
        .prepare(
          `
            SELECT 1 FROM events
            WHERE task_id=? AND type='turn.workspace-established'
            LIMIT 1
          `,
        )
        .get(task?.id),
    );
    return {
      task,
      turn,
      worker,
      project,
      attachments,
      workspaceEstablished,
    };
  }

  setTurnPhase(turnId, status) {
    const turn = this.getTurn(turnId);
    if (!turn) return null;
    this.db.prepare("UPDATE turns SET status=? WHERE id=?").run(status, turnId);
    this.db
      .prepare(`UPDATE tasks SET status='running', updated_at=? WHERE id=?`)
      .run(now(), turn.taskId);
    return this.getTurn(turnId);
  }

  setTaskThread(taskId, threadId) {
    if (!threadId) return;
    this.db
      .prepare(
        `
      UPDATE tasks SET codex_thread_id=COALESCE(codex_thread_id, ?), updated_at=? WHERE id=?
    `,
      )
      .run(threadId, now(), taskId);
  }

  recordCodexCompletion(turnId, codexFinal) {
    const turn = this.getTurn(turnId);
    if (!turn) return null;
    const timestamp = now();
    let event;
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE turns SET codex_final_json=? WHERE id=? AND status IN ('running','saving')",
        )
        .run(stringifyJson(codexFinal), turnId);
      event = this.insertEvent({
        taskId: turn.taskId,
        turnId,
        workerId: turn.workerId,
        type: "turn.codex.completed",
        phase: "codex",
        message: `Codex returned structured status '${codexFinal?.status || "unknown"}'`,
        data: {
          status: codexFinal?.status || null,
          changedFiles: Array.isArray(codexFinal?.changedFiles)
            ? codexFinal.changedFiles.map(String)
            : [],
          validation: Array.isArray(codexFinal?.validation)
            ? codexFinal.validation.map(String)
            : [],
        },
      });
      this.db
        .prepare("UPDATE tasks SET updated_at=? WHERE id=?")
        .run(timestamp, turn.taskId);
    });
    this.notifyEvent(event);
    return this.getTurn(turnId);
  }

  recordDeliveryAudit(turnId, audit) {
    const turn = this.getTurn(turnId);
    if (!turn) return null;
    let event;
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE turns SET delivery_audit_json=? WHERE id=? AND status IN ('running','saving')",
        )
        .run(stringifyJson(audit), turnId);
      event = this.insertEvent({
        taskId: turn.taskId,
        turnId,
        workerId: turn.workerId,
        type: "turn.delivery-audit.recorded",
        phase: "delivery-audit",
        level: audit?.safeForDeliveryRetry === true ? "info" : "warning",
        message:
          audit?.message ||
          "Recorded the exact post-Codex workspace state before delivery",
        data: audit,
      });
    });
    this.notifyEvent(event);
    return this.getTurn(turnId);
  }

  completeTurn(turnId, { codexFinal, commitSha, delivery = null }) {
    const turn = this.getTurn(turnId);
    if (!turn) return null;
    const task = this.getTask(turn.taskId);
    const project = task ? this.getProject(task.projectId) : null;
    const deliveredCommitSha = delivery?.commitSha || commitSha || null;
    const timestamp = now();
    const events = [];
    this.transaction(() => {
      this.db
        .prepare(
          `
        UPDATE turns SET status='success', codex_final_json=?, commit_sha=?,
          error_code=NULL, error_message=NULL, finished_at=? WHERE id=?
      `,
        )
        .run(stringifyJson(codexFinal), deliveredCommitSha, timestamp, turnId);
      const hasQueuedTurn = Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM turns WHERE task_id=? AND status='queued' LIMIT 1",
          )
          .get(turn.taskId),
      );
      this.db
        .prepare(
          `
        UPDATE tasks SET status=?, latest_commit_sha=COALESCE(?, latest_commit_sha), updated_at=?
        WHERE id=?
      `,
        )
        .run(
          hasQueuedTurn ? "queued" : "waiting_user",
          deliveredCommitSha,
          timestamp,
          turn.taskId,
        );
      events.push(
        this.insertEvent({
          taskId: task?.id || turn.taskId,
          turnId,
          workerId: turn.workerId,
          type: "turn.delivered",
          phase: "delivered",
          message: "Remote branch verified; conversation and commit were saved",
          data: {
            branchName: task?.branchName || null,
            commitSha: deliveredCommitSha,
            remoteSha: delivery?.remoteSha || null,
            pushed: delivery?.pushed === true,
            verified: delivery?.verified === true,
            threadId: task?.codexThreadId || null,
          },
        }),
      );

      const configuredRepositoryUrl =
        this.config.ozdqpBuildRepositoryUrl ||
        "http://git.dominogm.com/diaoyu/ozdqp.git";
      const eligible =
        this.config.ozdqpBuildEnabled === true &&
        project?.autoBuildEnabled === true &&
        project?.buildProjectKey === "ozdqp" &&
        normalizedRepositoryUrl(project?.repoUrl) ===
          normalizedRepositoryUrl(configuredRepositoryUrl) &&
        typeof task?.branchName === "string" &&
        task.branchName.trim().length > 0 &&
        delivery?.pushed === true &&
        delivery?.verified === true &&
        delivery?.commitSha === delivery?.remoteSha &&
        isFullCommitSha(delivery?.commitSha) &&
        isFullCommitSha(delivery?.remoteSha);
      if (eligible) {
        const commit = delivery.commitSha.toLowerCase();
        const dispatchId = `build-dispatch-${turnId}`;
        const idempotencyKey = `relay:${turnId}:${commit}`;
        const requestedBy = {
          system: "relay-unity-orchestrator",
          projectId: project.id,
          taskId: task.id,
          taskNumber: task.number,
          turnId,
          turnSequence: turn.sequence,
        };
        const inserted = this.db
          .prepare(
            `
            INSERT INTO build_dispatches (
              id, turn_id, turn_sequence, task_id, project_id, project_key, repository_url,
              branch_name, commit_sha, build_type, modules_json,
              player_base_version, requested_by_json, idempotency_key, status,
              attempt_count, next_attempt_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'cdn', ?, 1, ?, ?, 'pending', 0, ?, ?, ?)
            ON CONFLICT(turn_id) DO NOTHING
          `,
          )
          .run(
            dispatchId,
            turnId,
            turn.sequence,
            task.id,
            project.id,
            project.buildProjectKey,
            configuredRepositoryUrl,
            task.branchName,
            commit,
            stringifyJson(["all"]),
            stringifyJson(requestedBy),
            idempotencyKey,
            timestamp,
            timestamp,
            timestamp,
          );
        if (inserted.changes > 0) {
          events.push(
            this.insertEvent({
              taskId: task.id,
              turnId,
              workerId: turn.workerId,
              type: "build.dispatch.queued",
              phase: "build-dispatch",
              message: `OZDQP Windows CDN build queued for ${task.branchName}`,
              data: {
                dispatchId,
                projectKey: project.buildProjectKey,
                branchName: task.branchName,
                commitSha: commit,
                buildType: "cdn",
                status: "pending",
              },
            }),
          );
        }
      }
    });
    for (const event of events) this.notifyEvent(event);
    return this.getTurn(turnId);
  }

  getBuildDispatch(dispatchId) {
    return buildDispatchFromRow(
      this.db
        .prepare("SELECT * FROM build_dispatches WHERE id=?")
        .get(dispatchId),
    );
  }

  getBuildDispatchForTurn(turnId) {
    return buildDispatchFromRow(
      this.db
        .prepare("SELECT * FROM build_dispatches WHERE turn_id=?")
        .get(turnId),
    );
  }

  listBuildDispatches({ status = null, limit = 250 } = {}) {
    const boundedLimit = Math.max(1, Math.min(1_000, Number(limit) || 250));
    const rows = status
      ? this.db
          .prepare(
            "SELECT * FROM build_dispatches WHERE status=? ORDER BY created_at DESC, id DESC LIMIT ?",
          )
          .all(status, boundedLimit)
      : this.db
          .prepare(
            "SELECT * FROM build_dispatches ORDER BY created_at DESC, id DESC LIMIT ?",
          )
          .all(boundedLimit);
    return rows.map(buildDispatchFromRow);
  }

  claimNextBuildDispatch(timestamp = now()) {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT candidate.* FROM build_dispatches AS candidate
           WHERE candidate.status IN ('pending','retrying')
             AND NOT EXISTS (
               SELECT 1
               FROM build_dispatches AS earlier
               WHERE earlier.branch_name=candidate.branch_name
                 AND earlier.status IN ('pending','sending','retrying')
                 AND earlier.turn_sequence < candidate.turn_sequence
             )
           ORDER BY candidate.created_at ASC, candidate.task_id ASC,
             candidate.turn_sequence ASC, candidate.id ASC
           LIMIT 1`,
        )
        .get();
      if (!row || row.next_attempt_at > timestamp) return null;
      const claimed = this.db
        .prepare(
          `UPDATE build_dispatches
           SET status='sending', attempt_count=attempt_count+1, updated_at=?
           WHERE id=? AND status IN ('pending','retrying')`,
        )
        .run(timestamp, row.id);
      return claimed.changes > 0 ? this.getBuildDispatch(row.id) : null;
    });
  }

  acceptBuildDispatch(dispatchId, result) {
    const dispatch = this.getBuildDispatch(dispatchId);
    if (!dispatch) return null;
    const timestamp = now();
    let event;
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE build_dispatches
           SET status='accepted', ozdqp_job_id=?, last_http_status=?,
             last_error_code=NULL, last_error_message=NULL, updated_at=?,
             accepted_at=?, failed_at=NULL, build_status=?, build_step=?,
             build_cdn_url=?, build_error_message=NULL,
             status_checked_at=NULL, next_status_check_at=?,
             status_check_attempt_count=0, status_check_error_code=NULL,
             status_check_error_message=NULL
           WHERE id=?`,
        )
        .run(
          String(result.jobId).slice(0, 240),
          result.status || null,
          timestamp,
          timestamp,
          String(result.jobStatus || "queued")
            .trim()
            .toLowerCase()
            .slice(0, 80),
          typeof result.currentStep === "string"
            ? result.currentStep.trim().slice(0, 500) || null
            : null,
          typeof result.cdnUrl === "string"
            ? result.cdnUrl.trim().slice(0, 2_000) || null
            : null,
          timestamp,
          dispatchId,
        );
      event = this.insertEvent({
        taskId: dispatch.taskId,
        turnId: dispatch.turnId,
        type: "build.dispatch.accepted",
        phase: "build-dispatch",
        message: `OZDQP accepted the Windows CDN build for ${dispatch.branchName}`,
        data: {
          dispatchId,
          jobId: String(result.jobId).slice(0, 240),
          status: "accepted",
          buildStatus: String(result.jobStatus || "queued")
            .trim()
            .toLowerCase()
            .slice(0, 80),
          httpStatus: result.status || null,
          deduplicated: result.deduplicated === true,
          attemptCount: dispatch.attemptCount,
        },
      });
    });
    this.notifyEvent(event);
    return this.getBuildDispatch(dispatchId);
  }

  listBuildDispatchesForStatusCheck(timestamp = now(), limit = 8) {
    const boundedLimit = Math.max(1, Math.min(32, Number(limit) || 8));
    return this.db
      .prepare(
        `SELECT * FROM build_dispatches
         WHERE status='accepted'
           AND ozdqp_job_id IS NOT NULL
           AND next_status_check_at IS NOT NULL
           AND next_status_check_at<=?
           AND (build_status IS NULL OR build_status<>'completed')
         ORDER BY next_status_check_at ASC, accepted_at ASC, id ASC
         LIMIT ?`,
      )
      .all(timestamp, boundedLimit)
      .map(buildDispatchFromRow);
  }

  updateBuildStatus(dispatchId, job, { nextCheckAt = null } = {}) {
    const dispatch = this.getBuildDispatch(dispatchId);
    if (!dispatch || dispatch.status !== "accepted") return dispatch;
    const timestamp = now();
    const buildStatus = String(job?.status || "unknown")
      .trim()
      .toLowerCase()
      .slice(0, 80);
    const buildStep =
      typeof job?.currentStep === "string"
        ? job.currentStep.trim().slice(0, 500) || null
        : null;
    const buildCdnUrl =
      typeof job?.cdnUrl === "string"
        ? job.cdnUrl.trim().slice(0, 2_000) || null
        : null;
    const buildErrorMessage =
      typeof job?.error === "string"
        ? job.error.trim().slice(0, 2_000) || null
        : null;
    const buildStartedAt =
      typeof job?.startedAt === "string"
        ? job.startedAt.trim().slice(0, 80) || null
        : null;
    const buildFinishedAt =
      typeof job?.finishedAt === "string"
        ? job.finishedAt.trim().slice(0, 80) || null
        : null;
    const buildDurationSeconds =
      Number.isFinite(Number(job?.durationSeconds)) &&
      Number(job.durationSeconds) >= 0
        ? Number(job.durationSeconds)
        : null;
    // Packer can retry the same job ID after a failed attempt. Only a completed
    // job is immutable; keep failed jobs eligible for slower status checks so
    // Relay can surface a later queued/preparing/building attempt.
    const terminal = buildStatus === "completed";
    const changed =
      dispatch.buildStatus !== buildStatus ||
      dispatch.buildStep !== buildStep ||
      dispatch.buildCdnUrl !== buildCdnUrl ||
      dispatch.buildErrorMessage !== buildErrorMessage;
    let event = null;
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE build_dispatches
           SET build_status=?, build_step=?, build_cdn_url=?,
             build_error_message=?, build_started_at=?, build_finished_at=?,
             build_duration_seconds=?, status_checked_at=?,
             next_status_check_at=?, status_check_attempt_count=0,
             status_check_error_code=NULL, status_check_error_message=NULL,
             updated_at=?
           WHERE id=? AND status='accepted'`,
        )
        .run(
          buildStatus,
          buildStep,
          buildCdnUrl,
          buildErrorMessage,
          buildStartedAt,
          buildFinishedAt,
          buildDurationSeconds,
          timestamp,
          terminal ? null : nextCheckAt || timestamp,
          timestamp,
          dispatchId,
        );
      if (!changed) return;
      const labels = {
        queued: "queued",
        preparing: "preparing",
        building: "building",
        validating: "validating",
        publishing: "publishing",
        completed: "completed and ready to view",
        failed: "failed",
      };
      event = this.insertEvent({
        taskId: dispatch.taskId,
        turnId: dispatch.turnId,
        level:
          buildStatus === "failed"
            ? "error"
            : buildStatus === "completed"
              ? "success"
              : "info",
        type: `build.status.${buildStatus || "unknown"}`,
        phase: "build-status",
        message: `OZDQP Windows CDN build ${labels[buildStatus] || buildStatus || "updated"} for ${dispatch.branchName}`,
        data: {
          dispatchId,
          jobId: dispatch.ozdqpJobId,
          buildStatus,
          buildStep,
          cdnUrl: buildCdnUrl,
          finishedAt: buildFinishedAt,
          durationSeconds: buildDurationSeconds,
        },
      });
    });
    if (event) this.notifyEvent(event);
    return this.getBuildDispatch(dispatchId);
  }

  recordBuildStatusCheckFailure(
    dispatchId,
    error,
    { nextCheckAt = null } = {},
  ) {
    const dispatch = this.getBuildDispatch(dispatchId);
    if (!dispatch || dispatch.status !== "accepted") return dispatch;
    const timestamp = now();
    const safeError = safeBuildDispatchError(error);
    const attemptCount = dispatch.statusCheckAttemptCount + 1;
    const shouldNotify = dispatch.statusCheckErrorCode !== safeError.code;
    let event = null;
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE build_dispatches
           SET status_check_attempt_count=?, status_check_error_code=?,
             status_check_error_message=?, next_status_check_at=?, updated_at=?
           WHERE id=? AND status='accepted'`,
        )
        .run(
          attemptCount,
          safeError.code,
          safeError.message,
          nextCheckAt || timestamp,
          timestamp,
          dispatchId,
        );
      if (!shouldNotify) return;
      event = this.insertEvent({
        taskId: dispatch.taskId,
        turnId: dispatch.turnId,
        level: "warning",
        type: "build.status.unavailable",
        phase: "build-status",
        message: `OZDQP build progress is temporarily unavailable for ${dispatch.branchName}`,
        data: {
          dispatchId,
          jobId: dispatch.ozdqpJobId,
          buildStatus: dispatch.buildStatus,
          code: safeError.code,
          nextCheckAt: nextCheckAt || timestamp,
        },
      });
    });
    if (event) this.notifyEvent(event);
    return this.getBuildDispatch(dispatchId);
  }

  retryBuildDispatch(dispatchId, error, { nextAttemptAt, delayMs } = {}) {
    const dispatch = this.getBuildDispatch(dispatchId);
    if (!dispatch) return null;
    const timestamp = now();
    const safeError = safeBuildDispatchError(error);
    let event;
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE build_dispatches
           SET status='retrying', next_attempt_at=?, last_http_status=?,
             last_error_code=?, last_error_message=?, updated_at=?
           WHERE id=?`,
        )
        .run(
          nextAttemptAt || timestamp,
          safeError.status,
          safeError.code,
          safeError.message,
          timestamp,
          dispatchId,
        );
      event = this.insertEvent({
        taskId: dispatch.taskId,
        turnId: dispatch.turnId,
        level: "warning",
        type: "build.dispatch.retrying",
        phase: "build-dispatch",
        message: `OZDQP build dispatch will retry for ${dispatch.branchName}`,
        data: {
          dispatchId,
          status: "retrying",
          code: safeError.code,
          httpStatus: safeError.status,
          attemptCount: dispatch.attemptCount,
          nextAttemptAt: nextAttemptAt || timestamp,
          delayMs: Number(delayMs) || 0,
        },
      });
    });
    this.notifyEvent(event);
    return this.getBuildDispatch(dispatchId);
  }

  failBuildDispatch(dispatchId, error) {
    const dispatch = this.getBuildDispatch(dispatchId);
    if (!dispatch) return null;
    const timestamp = now();
    const safeError = safeBuildDispatchError(error);
    let event;
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE build_dispatches
           SET status='failed', last_http_status=?, last_error_code=?,
             last_error_message=?, updated_at=?, failed_at=?
           WHERE id=?`,
        )
        .run(
          safeError.status,
          safeError.code,
          safeError.message,
          timestamp,
          timestamp,
          dispatchId,
        );
      event = this.insertEvent({
        taskId: dispatch.taskId,
        turnId: dispatch.turnId,
        level: "error",
        type: "build.dispatch.failed",
        phase: "build-dispatch",
        message: `OZDQP build dispatch permanently failed for ${dispatch.branchName}`,
        data: {
          dispatchId,
          status: "failed",
          code: safeError.code,
          httpStatus: safeError.status,
          attemptCount: dispatch.attemptCount,
        },
      });
    });
    this.notifyEvent(event);
    return this.getBuildDispatch(dispatchId);
  }

  failTurn(turnId, error, { preserveWorker = true } = {}) {
    const turn = this.getTurn(turnId);
    if (!turn) return null;
    const timestamp = now();
    this.transaction(() => {
      this.db
        .prepare(
          `
        UPDATE turns SET status='failed', error_code=?, error_message=?, finished_at=? WHERE id=?
      `,
        )
        .run(
          error.code || "TURN_FAILED",
          error.message || String(error),
          timestamp,
          turnId,
        );
      const queued = this.db
        .prepare(
          "SELECT id FROM turns WHERE task_id=? AND status='queued' ORDER BY sequence LIMIT 1",
        )
        .get(turn.taskId);
      this.db
        .prepare(`UPDATE tasks SET status=?, updated_at=? WHERE id=?`)
        .run(queued ? "queued" : "failed", timestamp, turn.taskId);
      if (turn.workerId) {
        if (queued && preserveWorker) {
          this.db
            .prepare(
              "UPDATE turns SET worker_id=? WHERE id=? AND worker_id IS NULL",
            )
            .run(turn.workerId, queued.id);
        }
        this.db
          .prepare(
            `
          UPDATE workers SET status=?, current_turn_id=NULL, last_error=?, updated_at=? WHERE id=?
        `,
          )
          .run(
            preserveWorker ? "attention" : "ready",
            error.message || String(error),
            timestamp,
            turn.workerId,
          );
      }
    });
    return this.getTurn(turnId);
  }

  releaseWorkerAfterSuccess(workerId) {
    if (!workerId) return;
    this.db
      .prepare(
        `
      UPDATE workers SET status='ready', current_turn_id=NULL, last_error=NULL, updated_at=? WHERE id=?
    `,
      )
      .run(now(), workerId);
  }

  assignNextQueuedTurn(taskId, workerId) {
    if (!taskId || !workerId) return null;
    const queued = this.db
      .prepare(
        "SELECT id FROM turns WHERE task_id=? AND status='queued' ORDER BY sequence LIMIT 1",
      )
      .get(taskId);
    if (!queued) return null;
    this.db
      .prepare("UPDATE turns SET worker_id=? WHERE id=? AND worker_id IS NULL")
      .run(workerId, queued.id);
    return this.getTurn(queued.id);
  }

  cancelCurrentTurn(taskId, actorName = null) {
    const task = this.getTask(taskId);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    const row = this.db
      .prepare(
        `
      SELECT * FROM turns WHERE task_id=? AND status IN ('queued','preparing','running','saving','cancel_requested')
      ORDER BY CASE WHEN status='queued' THEN 1 ELSE 0 END, sequence DESC LIMIT 1
    `,
      )
      .get(taskId);
    if (!row)
      throw new HttpError(
        409,
        "NO_ACTIVE_TURN",
        "Task has no active or queued turn",
      );
    const turn = turnFromRow(row);
    const timestamp = now();
    const wasQueued = turn.status === "queued";
    this.transaction(() => {
      this.db
        .prepare(
          `
        UPDATE turns SET status='cancelled', error_code='CANCELLED_BY_USER',
          error_message='Cancelled by user', finished_at=? WHERE id=?
      `,
        )
        .run(timestamp, turn.id);
      const executingPlaceholders = EXECUTING_TURN_STATUSES.map(() => "?").join(
        ",",
      );
      const executing = this.db
        .prepare(
          `SELECT 1 FROM turns WHERE task_id=? AND status IN (${executingPlaceholders}) LIMIT 1`,
        )
        .get(taskId, ...EXECUTING_TURN_STATUSES);
      const queued = this.db
        .prepare(
          "SELECT id FROM turns WHERE task_id=? AND status='queued' ORDER BY sequence LIMIT 1",
        )
        .get(taskId);
      this.db
        .prepare(`UPDATE tasks SET status=?, updated_at=? WHERE id=?`)
        .run(
          executing ? "running" : queued ? "queued" : "waiting_user",
          timestamp,
          taskId,
        );
      if (turn.workerId && !wasQueued) {
        if (queued) {
          this.db
            .prepare(
              "UPDATE turns SET worker_id=? WHERE id=? AND worker_id IS NULL",
            )
            .run(turn.workerId, queued.id);
        }
        this.db
          .prepare(
            `
          UPDATE workers SET status='attention', current_turn_id=NULL,
            last_error='Turn cancelled after execution began; workspace preserved', updated_at=? WHERE id=?
        `,
          )
          .run(timestamp, turn.workerId);
      }
    });
    this.emit({
      taskId,
      turnId: turn.id,
      workerId: turn.workerId,
      actorName,
      type: "turn.cancelled",
      level: "warning",
      phase: "cancelled",
      message: wasQueued
        ? "Current queued turn was removed; task history is preserved"
        : "Current turn was cancelled; worker workspace is preserved for inspection",
    });
    return { turn: this.getTurn(turn.id), preserveWorker: !wasQueued };
  }

  retryTask(taskId, actorName = null) {
    const task = this.getTask(taskId);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    if (this.hasActiveTurn(taskId))
      throw new HttpError(
        409,
        "TURN_ALREADY_PENDING",
        "Task already has an active turn",
      );
    const latest = this.db
      .prepare(
        "SELECT * FROM turns WHERE task_id=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(taskId);
    if (
      !latest ||
      !["failed", "cancelled", "interrupted"].includes(latest.status)
    ) {
      throw new HttpError(
        409,
        "NOT_RETRYABLE",
        "Only failed, cancelled, or interrupted turns can be retried",
      );
    }
    const worker = latest.worker_id ? this.getWorker(latest.worker_id) : null;
    let codexFinal = parseJson(latest.codex_final_json, null);
    let audit = parseJson(latest.delivery_audit_json, null);
    let protectedLegacyEvidence = false;
    if (!codexFinal || !audit) {
      const legacy = legacyDeliveryRetryEvidence(
        this.config,
        task,
        turnFromRow(latest),
        worker,
      );
      if (legacy) {
        if (
          (codexFinal && !exactJson(codexFinal, legacy.final)) ||
          (audit && !exactJson(audit, legacy.audit))
        ) {
          throw new HttpError(
            409,
            "DELIVERY_RETRY_LEGACY_EVIDENCE_MISMATCH",
            "Persisted turn data conflicts with the protected legacy final/JSONL evidence",
          );
        }
        codexFinal = legacy.final;
        audit = legacy.audit;
        protectedLegacyEvidence = true;
      }
    }
    if (codexFinal?.status === "completed") {
      const changedFiles = Array.isArray(codexFinal.changedFiles)
        ? codexFinal.changedFiles.map(String)
        : [];
      const validation = Array.isArray(codexFinal.validation)
        ? codexFinal.validation.map(String)
        : [];
      const recordedChangedFiles = Array.isArray(audit?.changedFiles)
        ? audit.changedFiles.map(String)
        : null;
      const recordedValidation = Array.isArray(audit?.validation)
        ? audit.validation.map(String)
        : null;
      const files = Array.isArray(audit?.files) ? audit.files : null;
      const exactFileSet =
        files &&
        recordedChangedFiles &&
        files.length === recordedChangedFiles.length &&
        JSON.stringify(
          files
            .map((file) => String(file?.path || ""))
            .sort((left, right) => left.localeCompare(right)),
        ) ===
          JSON.stringify(
            [...recordedChangedFiles].sort((left, right) =>
              left.localeCompare(right),
            ),
          );
      const exactHashes =
        files &&
        files.every(
          (file) =>
            typeof file?.gitBlob === "string" &&
            /^[0-9a-f]{40,64}$/u.test(file.gitBlob) &&
            typeof file?.sha256 === "string" &&
            /^[0-9a-f]{64}$/u.test(file.sha256),
        );
      const safeStatuses =
        files &&
        files.every(
          (file) =>
            typeof file?.code === "string" &&
            /^[ MA]{2}$/u.test(file.code) &&
            /[MA]/u.test(file.code) &&
            file.originalPath == null &&
            file.unsafeReason == null,
        );
      const recordedOutputMatches =
        recordedChangedFiles &&
        recordedValidation &&
        JSON.stringify(changedFiles) === JSON.stringify(recordedChangedFiles) &&
        JSON.stringify(validation) === JSON.stringify(recordedValidation);
      const auditIsExact =
        audit?.version === 1 &&
        audit?.safeForDeliveryRetry === true &&
        audit?.completeFileSet === true &&
        audit?.branch === task.branchName &&
        typeof audit?.head === "string" &&
        /^[0-9a-f]{40,64}$/u.test(audit.head) &&
        typeof audit?.fingerprint === "string" &&
        /^[0-9a-f]{64}$/u.test(audit.fingerprint) &&
        Array.isArray(audit?.blockedPaths) &&
        audit.blockedPaths.length === 0 &&
        exactFileSet &&
        exactHashes &&
        safeStatuses &&
        recordedOutputMatches;
      if (!auditIsExact) {
        throw new HttpError(
          409,
          "DELIVERY_RETRY_AUDIT_UNSAFE",
          "Codex already completed, but the recorded delivery audit is missing or no longer proves the exact safe file set, hashes, statuses, and validation output",
        );
      }
      if (
        !worker ||
        worker.status !== "attention" ||
        worker.currentTurnId != null
      ) {
        throw new HttpError(
          409,
          "DELIVERY_RETRY_WORKER_NOT_PRESERVED",
          "Delivery-only retry requires the original preserved attention worker",
        );
      }
      const timestamp = now();
      let event;
      this.transaction(() => {
        const updated = this.db
          .prepare(
            `UPDATE turns
             SET status='queued', execution_mode='delivery_only',
               codex_final_json=?, delivery_audit_json=?,
               error_code=NULL, error_message=NULL, finished_at=NULL
             WHERE id=? AND status IN ('failed','interrupted')`,
          )
          .run(stringifyJson(codexFinal), stringifyJson(audit), latest.id);
        if (!updated.changes) {
          throw new HttpError(
            409,
            "DELIVERY_RETRY_STATE_CHANGED",
            "The original completed turn changed while delivery retry was being queued",
          );
        }
        this.db
          .prepare(
            "UPDATE tasks SET status='queued', closed_at=NULL, updated_at=? WHERE id=?",
          )
          .run(timestamp, taskId);
        event = this.insertEvent({
          taskId,
          turnId: latest.id,
          workerId: latest.worker_id,
          actorName,
          type: "turn.delivery-retry.queued",
          phase: "delivery-retry",
          message:
            "Queued delivery-only retry on the original completed Codex turn; Codex will not be launched",
          data: {
            executionMode: "delivery_only",
            auditFingerprint: audit.fingerprint,
            branch: audit.branch,
            head: audit.head,
            protectedLegacyEvidence,
          },
        });
      });
      this.notifyEvent(event);
      return this.getTurn(latest.id);
    }
    return this.appendTurn(taskId, {
      message: latest.user_message,
      priority: latest.priority,
      userName: actorName,
    });
  }

  closeTask(taskId, actorName = null) {
    const task = this.getTask(taskId);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    if (this.hasActiveTurn(taskId))
      throw new HttpError(
        409,
        "TASK_RUNNING",
        "Cancel the current turn before closing this task",
      );
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE tasks SET status='closed', closed_at=?, updated_at=? WHERE id=?`,
      )
      .run(timestamp, timestamp, taskId);
    this.emit({
      taskId,
      actorName,
      type: "task.closed",
      message: `Task #${task.number} closed; conversation and branch remain available`,
    });
    return this.getTask(taskId);
  }

  getTaskProjectManagementLink(taskId) {
    const row = this.db
      .prepare(
        `SELECT project_management_external_project_id AS externalProjectId,
          project_management_defect_id AS defectId,
          project_management_defect_url AS defectUrl,
          project_management_relay_user_name AS relayUserName,
          project_management_user_id AS userId,
          project_management_user_name AS userName,
          project_management_binding_key AS bindingKey,
          project_management_resolved_at AS resolvedAt
        FROM tasks WHERE id=?`,
      )
      .get(taskId);
    if (!row?.defectId) return null;
    return row;
  }

  startTaskCompletion(taskId, actorName = null) {
    const task = this.getTask(taskId);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE tasks SET completion_status='running', completion_step='merge_request',
          completion_error_code=NULL, completion_error_message=NULL,
          completion_started_at=?, completion_completed_at=NULL, updated_at=?
        WHERE id=?`,
      )
      .run(timestamp, timestamp, taskId);
    this.emit({
      taskId,
      actorName,
      type: "task.completion.started",
      phase: "merge-request",
      message: `Task #${task.number} completion started with merge request`,
    });
    return this.getTask(taskId);
  }

  recordTaskMerge(taskId, mergeRequest, actorName = null) {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE tasks SET completion_status='running', completion_step='merge_request',
          merge_request_iid=?, merge_request_url=?, merged_commit_sha=?,
          completion_error_code=NULL, completion_error_message=NULL, updated_at=?
        WHERE id=?`,
      )
      .run(
        mergeRequest?.iid || null,
        mergeRequest?.webUrl || null,
        mergeRequest?.mergedCommitSha || null,
        timestamp,
        taskId,
      );
    this.emit({
      taskId,
      actorName,
      type: "task.completion.merge-succeeded",
      phase: "merge-request",
      level: "success",
      message: `Merge request !${mergeRequest?.iid || "?"} merged into ${mergeRequest?.targetBranch || "the default branch"}`,
      data: {
        mergeRequestIid: mergeRequest?.iid || null,
        mergeRequestUrl: mergeRequest?.webUrl || null,
        sourceBranch: mergeRequest?.sourceBranch || null,
        targetBranch: mergeRequest?.targetBranch || null,
        mergedCommitSha: mergeRequest?.mergedCommitSha || null,
        sourceBranchDeleted: mergeRequest?.sourceBranchDeleted === true,
      },
    });
    return this.getTask(taskId);
  }

  startProjectManagementCompletion(taskId, actorName = null) {
    this.db
      .prepare(
        `UPDATE tasks SET completion_status='running', completion_step='project_management',
          completion_error_code=NULL, completion_error_message=NULL, updated_at=? WHERE id=?`,
      )
      .run(now(), taskId);
    this.emit({
      taskId,
      actorName,
      type: "task.completion.project-management-started",
      phase: "project-management",
      message:
        "Merge succeeded; marking the linked project-management defect resolved",
    });
    return this.getTask(taskId);
  }

  recordProjectManagementResolved(taskId, resolution, actorName = null) {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE tasks SET project_management_resolved_at=?,
          completion_status='running', completion_step='project_management',
          completion_error_code=NULL, completion_error_message=NULL, updated_at=?
        WHERE id=?`,
      )
      .run(timestamp, timestamp, taskId);
    this.emit({
      taskId,
      actorName,
      type: "task.completion.project-management-resolved",
      phase: "project-management",
      level: "success",
      message: resolution?.alreadyResolved
        ? "Linked project-management defect was already resolved"
        : "Linked project-management defect was marked resolved",
      data: {
        defectId: resolution?.defectId || null,
        status: resolution?.status || null,
        alreadyResolved: resolution?.alreadyResolved === true,
      },
    });
    return this.getTask(taskId);
  }

  failTaskCompletion(taskId, step, error, actorName = null) {
    const code = String(error?.code || "TASK_COMPLETION_FAILED").slice(0, 200);
    const message = String(error?.message || "Task completion failed").slice(
      0,
      2_000,
    );
    this.db
      .prepare(
        `UPDATE tasks SET completion_status='failed', completion_step=?,
          completion_error_code=?, completion_error_message=?, updated_at=? WHERE id=?`,
      )
      .run(step, code, message, now(), taskId);
    this.emit({
      taskId,
      actorName,
      type: "task.completion.failed",
      phase:
        step === "project_management"
          ? "project-management"
          : step === "relay"
            ? "relay"
            : "merge-request",
      level: "error",
      message,
      data: { code, step },
    });
    return this.getTask(taskId);
  }

  finishTaskCompletion(taskId, actorName = null) {
    const task = this.getTask(taskId);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE tasks SET status='closed', closed_at=?,
          completion_status='completed', completion_step='relay',
          completion_error_code=NULL, completion_error_message=NULL,
          completion_completed_at=?, updated_at=? WHERE id=?`,
      )
      .run(timestamp, timestamp, timestamp, taskId);
    this.emit({
      taskId,
      actorName,
      type: "task.closed",
      phase: "relay",
      level: "success",
      message: `Task #${task.number} closed after merge and linked-system completion`,
    });
    return this.getTask(taskId);
  }

  finishTaskRelayOnly(taskId, actorName = null) {
    const task = this.getTask(taskId);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE tasks SET status='closed', closed_at=?,
          completion_status='completed', completion_step='relay_only',
          completion_error_code=NULL, completion_error_message=NULL,
          completion_started_at=?, completion_completed_at=?, updated_at=?
        WHERE id=?`,
      )
      .run(timestamp, timestamp, timestamp, timestamp, taskId);
    this.emit({
      taskId,
      actorName,
      type: "task.closed",
      phase: "relay",
      level: "success",
      message: `Task #${task.number} closed in Relay only; merge request and linked-system updates were explicitly skipped`,
      data: {
        completionMode: "relay_only",
        mergeRequestSkipped: true,
        projectManagementSkipped: true,
      },
    });
    return this.getTask(taskId);
  }

  reopenTask(taskId, actorName = null) {
    const task = this.getTask(taskId);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    if (task.status !== "closed")
      throw new HttpError(409, "TASK_NOT_CLOSED", "Task is not closed");
    this.db
      .prepare(
        `UPDATE tasks SET status='waiting_user', closed_at=NULL,
          completion_status='idle', completion_step=NULL,
          completion_error_code=NULL, completion_error_message=NULL,
          merge_request_iid=NULL, merge_request_url=NULL,
          merged_commit_sha=NULL, completion_started_at=NULL,
          completion_completed_at=NULL, updated_at=? WHERE id=?`,
      )
      .run(now(), taskId);
    this.emit({
      taskId,
      actorName,
      type: "task.reopened",
      message: `Task #${task.number} reopened`,
    });
    return this.getTask(taskId);
  }

  ensureOpsThread() {
    const threadId = "ops-system";
    const existing = this.db
      .prepare("SELECT * FROM ops_threads WHERE id=?")
      .get(threadId);
    if (existing) return opsThreadFromRow(existing);
    const timestamp = now();
    this.db
      .prepare(
        `
        INSERT INTO ops_threads (
          id, title, is_system, status, codex_model,
          codex_reasoning_effort, codex_fast_mode, created_at, updated_at
        ) VALUES (?, ?, 1, 'idle', ?, ?, ?, ?, ?)
      `,
      )
      .run(
        threadId,
        "系统自动恢复",
        this.config.opsCodexModel ||
          this.config.codexModel ||
          DEFAULT_CODEX_MODEL,
        this.config.opsCodexReasoningEffort ||
          this.config.codexReasoningEffort ||
          DEFAULT_CODEX_REASONING_EFFORT,
        (this.config.opsCodexFastMode ??
          this.config.codexServiceTier === "fast")
          ? 1
          : 0,
        timestamp,
        timestamp,
      );
    return opsThreadFromRow(
      this.db.prepare("SELECT * FROM ops_threads WHERE id=?").get(threadId),
    );
  }

  listOpsThreads() {
    this.ensureOpsThread();
    return this.db
      .prepare(
        `
        SELECT ops_threads.*,
          (
            SELECT COUNT(*) FROM ops_turns
            WHERE ops_turns.thread_id=ops_threads.id
              AND ops_turns.sequence > ops_threads.cleared_through_sequence
          ) AS visible_turn_count,
          (
            SELECT COUNT(*) FROM ops_turns
            WHERE ops_turns.thread_id=ops_threads.id
          ) AS total_turn_count
        FROM ops_threads
        ORDER BY is_system DESC, updated_at DESC
      `,
      )
      .all()
      .map((row) => ({
        ...opsThreadFromRow(row),
        visibleTurnCount: Number(row.visible_turn_count || 0),
        totalTurnCount: Number(row.total_turn_count || 0),
      }));
  }

  getOpsThread(threadId = "ops-system") {
    if (threadId === "ops-system") this.ensureOpsThread();
    return opsThreadFromRow(
      this.db.prepare("SELECT * FROM ops_threads WHERE id=?").get(threadId),
    );
  }

  createOpsThread({ title, codexModel, codexReasoningEffort, codexFastMode }) {
    const timestamp = now();
    const threadId = id("ops-thread-");
    this.db
      .prepare(
        `
        INSERT INTO ops_threads (
          id, title, is_system, status, codex_model,
          codex_reasoning_effort, codex_fast_mode, created_at, updated_at
        ) VALUES (?, ?, 0, 'idle', ?, ?, ?, ?, ?)
      `,
      )
      .run(
        threadId,
        title,
        codexModel,
        codexReasoningEffort,
        codexFastMode ? 1 : 0,
        timestamp,
        timestamp,
      );
    return this.getOpsThread(threadId);
  }

  updateOpsThread(
    threadId,
    { title, codexModel, codexReasoningEffort, codexFastMode },
  ) {
    const thread = this.getOpsThread(threadId);
    if (!thread)
      throw new HttpError(
        404,
        "OPS_THREAD_NOT_FOUND",
        "System Codex conversation not found",
      );
    this.db
      .prepare(
        `
        UPDATE ops_threads
        SET title=?, codex_model=?, codex_reasoning_effort=?,
          codex_fast_mode=?, updated_at=?
        WHERE id=?
      `,
      )
      .run(
        title ?? thread.title,
        codexModel ?? thread.codexModel,
        codexReasoningEffort ?? thread.codexReasoningEffort,
        codexFastMode == null
          ? thread.codexFastMode
            ? 1
            : 0
          : codexFastMode
            ? 1
            : 0,
        now(),
        threadId,
      );
    return this.getOpsThread(threadId);
  }

  clearOpsThread(threadId) {
    return this.transaction(() => {
      const thread = this.getOpsThread(threadId);
      if (!thread)
        throw new HttpError(
          404,
          "OPS_THREAD_NOT_FOUND",
          "System Codex conversation not found",
        );
      const active = this.db
        .prepare(
          "SELECT 1 FROM ops_turns WHERE thread_id=? AND status IN ('queued','running') LIMIT 1",
        )
        .get(threadId);
      if (active)
        throw new HttpError(
          409,
          "OPS_THREAD_ACTIVE",
          "Wait for the active System Codex turn before clearing the screen",
        );
      const clearedThroughSequence = Number(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(sequence), 0) AS value FROM ops_turns WHERE thread_id=?",
          )
          .get(threadId).value,
      );
      this.db
        .prepare(
          "UPDATE ops_threads SET cleared_through_sequence=?, updated_at=? WHERE id=?",
        )
        .run(clearedThroughSequence, now(), threadId);
      return this.getOpsThread(threadId);
    });
  }

  setOpsCodexThread(threadId, codexThreadId) {
    if (codexThreadId === undefined) {
      codexThreadId = threadId;
      threadId = "ops-system";
    }
    if (!codexThreadId) return this.getOpsThread(threadId);
    const thread = this.getOpsThread(threadId);
    if (!thread)
      throw new HttpError(
        404,
        "OPS_THREAD_NOT_FOUND",
        "System Codex conversation not found",
      );
    this.db
      .prepare(
        `
        UPDATE ops_threads
        SET codex_thread_id=COALESCE(codex_thread_id, ?), updated_at=?
        WHERE id=?
      `,
      )
      .run(codexThreadId, now(), thread.id);
    return this.getOpsThread(threadId);
  }

  listOpsTurns({ threadId = null, includeCleared = false } = {}) {
    this.ensureOpsThread();
    const conditions = [];
    const values = [];
    if (threadId) {
      conditions.push("ops_turns.thread_id=?");
      values.push(threadId);
    }
    if (!includeCleared) {
      conditions.push(
        "ops_turns.sequence > ops_threads.cleared_through_sequence",
      );
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db
      .prepare(
        `
        SELECT ops_turns.* FROM ops_turns
        JOIN ops_threads ON ops_threads.id=ops_turns.thread_id
        ${where}
        ORDER BY ops_turns.created_at ASC, ops_turns.sequence ASC
      `,
      )
      .all(...values)
      .map(opsTurnFromRow);
  }

  getOpsTurn(opsTurnId) {
    return opsTurnFromRow(
      this.db.prepare("SELECT * FROM ops_turns WHERE id=?").get(opsTurnId),
    );
  }

  findActiveRecoveryTurn(targetTaskId = null) {
    const row = targetTaskId
      ? this.db
          .prepare(
            `
            SELECT * FROM ops_turns
            WHERE trigger='repair' AND target_task_id=?
              AND status IN ('queued','running')
            ORDER BY created_at ASC LIMIT 1
          `,
          )
          .get(targetTaskId)
      : this.db
          .prepare(
            `
            SELECT * FROM ops_turns
            WHERE trigger='repair' AND target_task_id IS NULL
              AND status IN ('queued','running')
            ORDER BY created_at ASC LIMIT 1
          `,
          )
          .get();
    return opsTurnFromRow(row);
  }

  appendOpsTurn({
    message,
    authorName = "Relay",
    trigger = "manual",
    incidentId = null,
    threadId = "ops-system",
    targetTaskId = null,
    parentOpsTurnId = null,
  }) {
    const thread = this.getOpsThread(threadId);
    if (!thread)
      throw new HttpError(
        404,
        "OPS_THREAD_NOT_FOUND",
        "System Codex conversation not found",
      );
    const timestamp = now();
    const opsTurnId = id("ops-turn-");
    const sequence = Number(
      this.db
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM ops_turns WHERE thread_id=?",
        )
        .get(thread.id).value,
    );
    this.db
      .prepare(
        `
        INSERT INTO ops_turns (
          id, thread_id, sequence, trigger, incident_id, target_task_id,
          parent_ops_turn_id, user_message, author_name, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
      `,
      )
      .run(
        opsTurnId,
        thread.id,
        sequence,
        trigger,
        incidentId,
        targetTaskId,
        parentOpsTurnId,
        message,
        authorName,
        timestamp,
      );
    this.db
      .prepare(
        "UPDATE ops_threads SET status='queued', updated_at=? WHERE id=?",
      )
      .run(timestamp, thread.id);
    if (incidentId) {
      this.db
        .prepare(
          "UPDATE incidents SET status='queued', updated_at=? WHERE id=? AND resolved_at IS NULL",
        )
        .run(timestamp, incidentId);
    }
    const turn = this.getOpsTurn(opsTurnId);
    queueMicrotask(() =>
      this.emit({
        opsTurnId,
        incidentId,
        actorName: authorName,
        type: "ops.turn.queued",
        phase: "ops",
        message: `System Codex turn ${sequence} queued`,
        data: { trigger },
      }),
    );
    return turn;
  }

  appendAutoRecoveryTurn({
    message,
    incidentId,
    sourceEventId,
    authorName = "Relay Auto Recovery",
    threadId = "ops-system",
  }) {
    const sourceKey = sourceEventKey(sourceEventId);
    if (!sourceKey) {
      return {
        turn: this.appendOpsTurn({
          message,
          incidentId,
          authorName,
          trigger: "incident",
          threadId,
        }),
        created: true,
      };
    }
    this.ensureOpsThread();
    return this.transaction(() => {
      const claim = this.db
        .prepare(
          `
          SELECT source_event_id, incident_id, auto_recovery_turn_id
          FROM incident_source_event_claims
          WHERE source_event_id=?
        `,
        )
        .get(sourceKey);
      if (!claim) {
        throw new Error(
          `Source event ${sourceKey} must be claimed before auto recovery is queued`,
        );
      }
      if (claim.incident_id !== incidentId) {
        throw new Error(
          `Source event ${sourceKey} is claimed by incident ${claim.incident_id}`,
        );
      }
      if (claim.auto_recovery_turn_id) {
        return {
          turn: this.getOpsTurn(claim.auto_recovery_turn_id),
          created: false,
        };
      }
      const incidentRow = this.db
        .prepare("SELECT resolved_at FROM incidents WHERE id=?")
        .get(incidentId);
      if (!incidentRow || incidentRow.resolved_at) {
        return { turn: null, created: false };
      }
      const thread = this.getOpsThread(threadId);
      if (!thread)
        throw new HttpError(
          404,
          "OPS_THREAD_NOT_FOUND",
          "System Codex conversation not found",
        );
      const timestamp = now();
      const opsTurnId = id("ops-turn-");
      const sequence = Number(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM ops_turns WHERE thread_id=?",
          )
          .get(thread.id).value,
      );
      this.db
        .prepare(
          `
          INSERT INTO ops_turns (
            id, thread_id, sequence, trigger, incident_id, user_message,
            author_name, status, created_at
          ) VALUES (?, ?, ?, 'incident', ?, ?, ?, 'queued', ?)
        `,
        )
        .run(
          opsTurnId,
          thread.id,
          sequence,
          incidentId,
          message,
          authorName,
          timestamp,
        );
      const claimed = this.db
        .prepare(
          `
          UPDATE incident_source_event_claims
          SET auto_recovery_turn_id=?
          WHERE source_event_id=? AND auto_recovery_turn_id IS NULL
        `,
        )
        .run(opsTurnId, sourceKey);
      if (!claimed.changes) {
        throw new Error(
          `Source event ${sourceKey} auto recovery was claimed concurrently`,
        );
      }
      this.db
        .prepare(
          "UPDATE ops_threads SET status='queued', updated_at=? WHERE id=?",
        )
        .run(timestamp, thread.id);
      this.db
        .prepare(
          "UPDATE incidents SET status='queued', updated_at=? WHERE id=? AND resolved_at IS NULL",
        )
        .run(timestamp, incidentId);
      const turn = this.getOpsTurn(opsTurnId);
      queueMicrotask(() =>
        this.emit({
          opsTurnId,
          incidentId,
          actorName: authorName,
          type: "ops.turn.queued",
          phase: "ops",
          message: `System Codex turn ${sequence} queued`,
          data: { trigger: "incident", sourceEventId },
        }),
      );
      return { turn, created: true };
    });
  }

  claimNextOpsTurn() {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `
          SELECT queued.* FROM ops_turns AS queued
          WHERE queued.status='queued'
            AND NOT EXISTS (
              SELECT 1 FROM ops_turns AS active
              WHERE active.thread_id=queued.thread_id
                AND active.status='running'
            )
          ORDER BY queued.created_at ASC LIMIT 1
        `,
        )
        .get();
      if (!row) return null;
      const timestamp = now();
      const claimed = this.db
        .prepare(
          "UPDATE ops_turns SET status='running', started_at=? WHERE id=? AND status='queued'",
        )
        .run(timestamp, row.id);
      if (!claimed.changes) return null;
      this.db
        .prepare(
          "UPDATE ops_threads SET status='running', updated_at=? WHERE id=?",
        )
        .run(timestamp, row.thread_id);
      if (row.incident_id) {
        this.db
          .prepare(
            `
            UPDATE incidents
            SET status='diagnosing', attempt_count=attempt_count+1, updated_at=?
            WHERE id=? AND resolved_at IS NULL
          `,
          )
          .run(timestamp, row.incident_id);
      }
      return this.getOpsTurn(row.id);
    });
  }

  completeOpsTurn(opsTurnId, final) {
    const turn = this.getOpsTurn(opsTurnId);
    if (!turn) return null;
    const timestamp = now();
    this.db
      .prepare(
        `
        UPDATE ops_turns
        SET status='completed', final_json=?, error_code=NULL,
          error_message=NULL, finished_at=?
        WHERE id=?
      `,
      )
      .run(stringifyJson(final), timestamp, opsTurnId);
    this.refreshOpsThreadStatus(turn.threadId, timestamp);
    return this.getOpsTurn(opsTurnId);
  }

  requeueOpsTurn(opsTurnId, message = null) {
    const turn = this.getOpsTurn(opsTurnId);
    if (!turn) return null;
    const timestamp = now();
    this.db
      .prepare(
        `
        UPDATE ops_turns
        SET status='queued', error_code=NULL, error_message=?,
          started_at=NULL, finished_at=NULL
        WHERE id=?
      `,
      )
      .run(message, opsTurnId);
    this.db
      .prepare(
        "UPDATE ops_threads SET status='queued', updated_at=? WHERE id=?",
      )
      .run(timestamp, turn.threadId);
    return this.getOpsTurn(opsTurnId);
  }

  failOpsTurn(opsTurnId, error) {
    const turn = this.getOpsTurn(opsTurnId);
    if (!turn) return null;
    const timestamp = now();
    this.db
      .prepare(
        `
        UPDATE ops_turns
        SET status='failed', error_code=?, error_message=?, finished_at=?
        WHERE id=?
      `,
      )
      .run(
        error?.code || "OPS_TURN_FAILED",
        error?.message || String(error),
        timestamp,
        opsTurnId,
      );
    this.refreshOpsThreadStatus(turn.threadId, timestamp);
    if (turn.incidentId) {
      this.db
        .prepare(
          `
          UPDATE incidents SET status='failed', error=?, updated_at=?
          WHERE id=? AND resolved_at IS NULL
        `,
        )
        .run(error?.message || String(error), timestamp, turn.incidentId);
    }
    return this.getOpsTurn(opsTurnId);
  }

  refreshOpsThreadStatus(threadId, timestamp = now()) {
    const running = this.db
      .prepare(
        "SELECT 1 FROM ops_turns WHERE thread_id=? AND status='running' LIMIT 1",
      )
      .get(threadId);
    const queued = this.db
      .prepare(
        "SELECT 1 FROM ops_turns WHERE thread_id=? AND status='queued' LIMIT 1",
      )
      .get(threadId);
    this.db
      .prepare("UPDATE ops_threads SET status=?, updated_at=? WHERE id=?")
      .run(
        running ? "running" : queued ? "queued" : "idle",
        timestamp,
        threadId,
      );
    return this.getOpsThread(threadId);
  }

  createIncident(input) {
    const timestamp = now();
    const sourceKey = sourceEventKey(input.sourceEventId);
    return this.transaction(() => {
      if (sourceKey) {
        const claimedRow = this.db
          .prepare(
            `
            SELECT incidents.*
            FROM incident_source_event_claims AS claim
            JOIN incidents ON incidents.id=claim.incident_id
            WHERE claim.source_event_id=?
          `,
          )
          .get(sourceKey);
        if (claimedRow) {
          return {
            incident: incidentFromRow(claimedRow),
            created: false,
            sourceEventClaimed: false,
          };
        }
      }
      let existingRow = input.canonicalIncidentId
        ? this.db
            .prepare(
              "SELECT * FROM incidents WHERE id=? AND resolved_at IS NULL",
            )
            .get(input.canonicalIncidentId)
        : null;
      if (!existingRow) {
        existingRow = this.db
          .prepare(
            `
            SELECT * FROM incidents
            WHERE fingerprint=? AND resolved_at IS NULL
            ORDER BY created_at ASC, id ASC LIMIT 1
          `,
          )
          .get(input.fingerprint);
      }
      if (existingRow) {
        this.db
          .prepare(
            `
            UPDATE incidents
            SET source_event_id=COALESCE(source_event_id, ?),
              task_id=COALESCE(?, task_id), turn_id=COALESCE(?, turn_id),
              worker_id=COALESCE(?, worker_id), title=?, error=?,
              context_json=?, status=CASE WHEN ? THEN 'open' ELSE status END,
              resolved_at=CASE WHEN ? THEN NULL ELSE resolved_at END,
              updated_at=?
            WHERE id=?
          `,
          )
          .run(
            sourceKey,
            input.taskId || null,
            input.turnId || null,
            input.workerId || null,
            input.title,
            input.error,
            stringifyJson(input.context || null),
            input.reopenExisting ? 1 : 0,
            input.reopenExisting ? 1 : 0,
            timestamp,
            existingRow.id,
          );
        if (sourceKey) {
          this.db
            .prepare(
              `
              INSERT INTO incident_source_event_claims (
                source_event_id, incident_id, claimed_at
              ) VALUES (?, ?, ?)
            `,
            )
            .run(sourceKey, existingRow.id, timestamp);
        }
        return {
          incident: this.getIncident(existingRow.id),
          created: false,
          sourceEventClaimed: Boolean(sourceKey),
        };
      }
      const incidentId = id("incident-");
      this.db
        .prepare(
          `
          INSERT INTO incidents (
            id, fingerprint, status, severity, source_event_id, task_id,
            turn_id, worker_id, title, error, context_json, created_at, updated_at
          ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          incidentId,
          input.fingerprint,
          input.severity || "error",
          sourceKey,
          input.taskId || null,
          input.turnId || null,
          input.workerId || null,
          input.title,
          input.error,
          stringifyJson(input.context || null),
          timestamp,
          timestamp,
        );
      if (sourceKey) {
        this.db
          .prepare(
            `
            INSERT INTO incident_source_event_claims (
              source_event_id, incident_id, claimed_at
            ) VALUES (?, ?, ?)
          `,
          )
          .run(sourceKey, incidentId, timestamp);
      }
      return {
        incident: this.getIncident(incidentId),
        created: true,
        sourceEventClaimed: Boolean(sourceKey),
      };
    });
  }

  getIncident(incidentId) {
    return incidentFromRow(
      this.db.prepare("SELECT * FROM incidents WHERE id=?").get(incidentId),
    );
  }

  getIncidentBySourceEventId(sourceEventId) {
    const sourceKey = sourceEventKey(sourceEventId);
    if (!sourceKey) return null;
    return incidentFromRow(
      this.db
        .prepare(
          `
          SELECT incidents.*
          FROM incident_source_event_claims AS claim
          JOIN incidents ON incidents.id=claim.incident_id
          WHERE claim.source_event_id=?
        `,
        )
        .get(sourceKey),
    );
  }

  listIncidents({ limit = 100 } = {}) {
    return this.db
      .prepare("SELECT * FROM incidents ORDER BY updated_at DESC LIMIT ?")
      .all(limit)
      .map(incidentFromRow);
  }

  updateIncident(
    incidentId,
    { status, lastAction, error, context, resolved = false } = {},
  ) {
    const incident = this.getIncident(incidentId);
    if (!incident) return null;
    const timestamp = now();
    this.db
      .prepare(
        `
        UPDATE incidents
        SET status=COALESCE(?, status), last_action=COALESCE(?, last_action),
          error=COALESCE(?, error), context_json=COALESCE(?, context_json),
          updated_at=?, resolved_at=CASE WHEN ? THEN ? ELSE resolved_at END
        WHERE id=?
      `,
      )
      .run(
        status || null,
        lastAction || null,
        error || null,
        context === undefined ? null : stringifyJson(context),
        timestamp,
        resolved ? 1 : 0,
        timestamp,
        incidentId,
      );
    return this.getIncident(incidentId);
  }

  reopenIncident(incidentId, error = null) {
    const timestamp = now();
    this.db
      .prepare(
        `
        UPDATE incidents SET status='open', error=COALESCE(?, error),
          resolved_at=NULL, updated_at=? WHERE id=?
      `,
      )
      .run(error, timestamp, incidentId);
    return this.getIncident(incidentId);
  }

  createOpsAction({
    opsTurnId,
    incidentId = null,
    type,
    targetId = null,
    message = null,
    reason = null,
    reversible = true,
  }) {
    const actionId = id("ops-action-");
    this.db
      .prepare(
        `
        INSERT INTO ops_actions (
          id, ops_turn_id, incident_id, type, target_id, message, reason,
          status, reversible, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `,
      )
      .run(
        actionId,
        opsTurnId,
        incidentId,
        type,
        targetId,
        message,
        reason,
        reversible ? 1 : 0,
        now(),
      );
    return this.getOpsAction(actionId);
  }

  getOpsAction(actionId) {
    return opsActionFromRow(
      this.db.prepare("SELECT * FROM ops_actions WHERE id=?").get(actionId),
    );
  }

  listOpsActions() {
    return this.db
      .prepare("SELECT * FROM ops_actions ORDER BY created_at DESC LIMIT 250")
      .all()
      .map(opsActionFromRow);
  }

  updateOpsAction(actionId, status, { result = null, error = null } = {}) {
    const timestamp = now();
    const terminal = ["completed", "failed", "skipped"].includes(status);
    this.db
      .prepare(
        `
        UPDATE ops_actions
        SET status=?, result_json=?, error=?,
          started_at=CASE WHEN ?='running' THEN COALESCE(started_at, ?) ELSE started_at END,
          finished_at=CASE WHEN ? THEN ? ELSE finished_at END
        WHERE id=?
      `,
      )
      .run(
        status,
        stringifyJson(result),
        error,
        status,
        timestamp,
        terminal ? 1 : 0,
        timestamp,
        actionId,
      );
    return this.getOpsAction(actionId);
  }

  createRepairRun({ opsTurnId = null, incidentId = null, instructions }) {
    const repairId = id("repair-");
    const timestamp = now();
    this.db
      .prepare(
        `
        INSERT INTO repair_runs (
          id, ops_turn_id, incident_id, status, instructions, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', ?, ?, ?)
      `,
      )
      .run(repairId, opsTurnId, incidentId, instructions, timestamp, timestamp);
    return this.getRepairRun(repairId);
  }

  getRepairRun(repairId) {
    return repairRunFromRow(
      this.db.prepare("SELECT * FROM repair_runs WHERE id=?").get(repairId),
    );
  }

  listRepairRuns() {
    return this.db
      .prepare("SELECT * FROM repair_runs ORDER BY created_at DESC LIMIT 100")
      .all()
      .map(repairRunFromRow);
  }

  updateRepairRun(repairId, changes = {}) {
    const fields = {
      status: "status",
      branchName: "branch_name",
      worktreePath: "worktree_path",
      baseSha: "base_sha",
      commitSha: "commit_sha",
      codexThreadId: "codex_thread_id",
      validation: "validation_json",
      error: "error",
      deployedAt: "deployed_at",
      rolledBackAt: "rolled_back_at",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(fields)) {
      if (!(key in changes)) continue;
      assignments.push(`${column}=?`);
      values.push(
        key === "validation" ? stringifyJson(changes[key]) : changes[key],
      );
    }
    if (!assignments.length) return this.getRepairRun(repairId);
    assignments.push("updated_at=?");
    values.push(now(), repairId);
    this.db
      .prepare(`UPDATE repair_runs SET ${assignments.join(", ")} WHERE id=?`)
      .run(...values);
    return this.getRepairRun(repairId);
  }

  snapshot() {
    const projects = this.listProjects();
    const workers = this.listWorkers();
    const turns = this.listTurnsWithAttachments();
    const tasks = this.listTasks();
    const projectNames = new Map(
      projects.map((project) => [project.id, project.name]),
    );
    const turnsByTask = new Map();
    for (const turn of turns) {
      const collection = turnsByTask.get(turn.taskId) || [];
      collection.push(turn);
      turnsByTask.set(turn.taskId, collection);
    }
    const enrichedTasks = tasks.map((task) => {
      const taskTurns = turnsByTask.get(task.id) || [];
      const currentTurn =
        taskTurns.find((turn) => ACTIVE_TURN_STATUSES.includes(turn.status)) ||
        taskTurns[0] ||
        null;
      return {
        ...task,
        projectName: projectNames.get(task.projectId) || null,
        currentTurn,
        turnCount: taskTurns.length,
      };
    });
    const queued = turns
      .filter((turn) => turn.status === "queued")
      .sort(
        (a, b) =>
          b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
      );
    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    const queue = queued.map((turn, index) => {
      const task = tasksById.get(turn.taskId);
      return {
        ...turn,
        position: index + 1,
        taskTitle: task?.title || null,
        taskNumber: task?.number || null,
        projectName: task ? projectNames.get(task.projectId) || null : null,
      };
    });
    return {
      projects,
      workers,
      tasks: enrichedTasks,
      turns,
      ops: {
        thread: this.getOpsThread(),
        threads: this.listOpsThreads(),
        turns: this.listOpsTurns(),
        incidents: this.listIncidents(),
        actions: this.listOpsActions(),
        repairs: this.listRepairRuns(),
      },
      queue,
      buildDispatches: this.listBuildDispatches({ limit: 250 }),
      events: this.listEvents({ limit: 120 }),
      stats: {
        projects: projects.length,
        workers: workers.length,
        readyWorkers: workers.filter((worker) => worker.status === "ready")
          .length,
        busyWorkers: workers.filter((worker) => worker.status === "busy")
          .length,
        queuedTurns: queue.length,
        runningTurns: turns.filter((turn) =>
          ["preparing", "running", "saving"].includes(turn.status),
        ).length,
        attentionWorkers: workers.filter(
          (worker) => worker.status === "attention",
        ).length,
        pendingBuildDispatches: this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM build_dispatches WHERE status IN ('pending','sending','retrying')",
          )
          .get().count,
      },
    };
  }
}
