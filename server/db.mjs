import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  asBoolean,
  HttpError,
  id,
  now,
  parseJson,
  slug,
  stringifyJson,
} from "./util.mjs";

const ACTIVE_TURN_STATUSES = [
  "queued",
  "preparing",
  "running",
  "saving",
  "cancel_requested",
];

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
  return {
    id: row.id,
    number: row.task_number,
    title: row.title,
    projectId: row.project_id,
    baseBranch: row.base_branch,
    branchName: row.branch_name,
    codexThreadId: row.codex_thread_id,
    status: row.status,
    latestCommitSha: row.latest_commit_sha,
    priority: row.priority,
    autoRelease: asBoolean(row.auto_release),
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
    status: row.status,
    priority: row.priority,
    workerId: row.worker_id,
    codexFinal: result,
    result,
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
    level: row.level,
    type: row.type,
    phase: row.phase,
    message: row.message,
    data: parseJson(row.data_json, null),
    createdAt: row.created_at,
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

export class Store {
  constructor(config) {
    this.config = config;
    this.listeners = new Set();
    fs.mkdirSync(config.dataDirectory, { recursive: true });
    fs.mkdirSync(config.uploadDirectory, { recursive: true });
    fs.mkdirSync(config.logDirectory, { recursive: true });
    this.db = new DatabaseSync(config.databasePath);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.migrate();
    this.reconcileInterruptedWork();
    if (config.adapter === "mock" && config.seedMockData) this.seedMockData();
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
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        base_branch TEXT NOT NULL,
        branch_name TEXT NOT NULL UNIQUE,
        codex_thread_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        latest_commit_sha TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        auto_release INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        user_message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        priority INTEGER NOT NULL DEFAULT 0,
        worker_id TEXT REFERENCES workers(id) ON DELETE SET NULL,
        codex_final_json TEXT,
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

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS turns_queue_idx ON turns(status, priority DESC, created_at ASC);
      CREATE INDEX IF NOT EXISTS turns_task_idx ON turns(task_id, sequence DESC);
      CREATE INDEX IF NOT EXISTS events_created_idx ON events(id DESC);
      CREATE INDEX IF NOT EXISTS workers_ready_idx ON workers(enabled, status, project_id);
    `);
    const projectColumns = this.db.prepare("PRAGMA table_info(projects)").all();
    if (!projectColumns.some((column) => column.name === "unity_health_url")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN unity_health_url TEXT");
    }
    const taskColumns = this.db.prepare("PRAGMA table_info(tasks)").all();
    if (!taskColumns.some((column) => column.name === "idempotency_key")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN idempotency_key TEXT");
    }
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
    this.db
      .prepare(
        `
      UPDATE projects SET
        unity_skill_url='http://{internalIp}:8090/mcp',
        unity_health_url='http://{internalIp}:8090/health',
        unity_save_url='http://{internalIp}:8090/api/save',
        updated_at=?
      WHERE id='project-unity-client'
        AND repo_url='https://example.invalid/unity-client.git'
    `,
      )
      .run(now());
  }

  seedMockData() {
    const count = this.db
      .prepare("SELECT COUNT(*) AS count FROM projects")
      .get().count;
    if (count > 0) return;
    const timestamp = now();
    const projectId = "project-unity-client";
    this.db
      .prepare(
        `
      INSERT INTO projects (
        id, name, repo_url, default_branch, guest_project_path, smb_path,
        unity_version, unity_skill_url, unity_health_url, unity_save_url, checkpoint_name, enabled,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `,
      )
      .run(
        projectId,
        "Unity Client",
        "https://example.invalid/unity-client.git",
        "main",
        "D:\\Work\\unity-client",
        "\\\\172.30.240.11\\Work\\unity-client",
        "2022.3 LTS",
        "http://{internalIp}:8090/mcp",
        "http://{internalIp}:8090/health",
        "http://{internalIp}:8090/api/save",
        "PROJECT_READY",
        timestamp,
        timestamp,
      );
    const workers = [
      ["worker-lin-01", "lin-worker-01", "172.30.240.11", "ready"],
      ["worker-lin-02", "lin-worker-02", "172.30.240.12", "ready"],
      ["worker-lin-03", "lin-worker-03", "172.30.240.13", "stopped"],
    ];
    const statement = this.db.prepare(`
      INSERT INTO workers (
        id, name, vm_name, project_id, checkpoint_name, internal_ip, share_path,
        status, enabled, health_json, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'PROJECT_READY', ?, ?, ?, 1, ?, ?, ?, ?)
    `);
    for (const [workerId, name, internalIp, status] of workers) {
      const running = status === "ready";
      statement.run(
        workerId,
        name,
        name,
        projectId,
        internalIp,
        `\\\\${internalIp}\\Work\\unity-client`,
        status,
        stringifyJson({
          vm: running,
          heartbeat: running,
          smb: running,
          unity: running,
          skill: running,
          checkedAt: timestamp,
        }),
        timestamp,
        timestamp,
        timestamp,
      );
    }
    this.emit({
      type: "system.seeded",
      level: "info",
      message: "Mock project and workers are ready",
      data: { projectId, workerCount: workers.length },
    });
  }

  reconcileInterruptedWork() {
    const timestamp = now();
    const active = this.db
      .prepare(
        `
      SELECT id, task_id, worker_id FROM turns
      WHERE status IN ('preparing', 'running', 'saving', 'cancel_requested')
    `,
      )
      .all();
    if (active.length === 0) return;
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
        this.db
          .prepare(`UPDATE tasks SET status='failed', updated_at=? WHERE id=?`)
          .run(timestamp, turn.task_id);
        if (turn.worker_id) {
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

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit({
    taskId = null,
    turnId = null,
    workerId = null,
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
      INSERT INTO events (task_id, turn_id, worker_id, level, type, phase, message, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        taskId,
        turnId,
        workerId,
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
      level,
      type,
      phase,
      message,
      data,
      createdAt,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* disconnected listener */
      }
    }
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

  createProject(input) {
    const projectId = input.id || id("project-");
    const timestamp = now();
    this.db
      .prepare(
        `
      INSERT INTO projects (
        id, name, repo_url, default_branch, guest_project_path, smb_path,
        unity_version, unity_skill_url, unity_health_url, unity_save_url, checkpoint_name, enabled,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        timestamp,
        timestamp,
      );
    const project = this.getProject(projectId);
    this.emit({
      type: "project.created",
      message: `Project ${project.name} created`,
      data: { projectId },
    });
    return project;
  }

  updateProject(projectId, changes) {
    if (!this.getProject(projectId))
      throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found");
    const entries = Object.entries(PROJECT_FIELDS).filter(([key]) =>
      Object.hasOwn(changes, key),
    );
    if (entries.length === 0) return this.getProject(projectId);
    const assignments = entries.map(([, column]) => `${column}=?`);
    const values = entries.map(([key]) =>
      key === "enabled" ? (changes[key] ? 1 : 0) : changes[key],
    );
    values.push(now(), projectId);
    this.db
      .prepare(
        `UPDATE projects SET ${assignments.join(", ")}, updated_at=? WHERE id=?`,
      )
      .run(...values);
    const project = this.getProject(projectId);
    this.emit({
      type: "project.updated",
      message: `Project ${project.name} updated`,
      data: { projectId },
    });
    return project;
  }

  deleteProject(projectId) {
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

  createWorker(input) {
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
          skill: false,
        }),
        timestamp,
        timestamp,
      );
    const worker = this.getWorker(workerId);
    this.emit({
      workerId,
      type: "worker.created",
      message: `Worker ${worker.name} created`,
    });
    return worker;
  }

  updateWorker(workerId, changes) {
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
      type: "worker.updated",
      message: `Worker ${worker.name} updated`,
    });
    return worker;
  }

  deleteWorker(workerId) {
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
          : health.ready === false ||
              health.skill === false ||
              health.unity === false
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
      this.db
        .prepare(
          `
        INSERT INTO tasks (
          id, task_number, idempotency_key, title, project_id, base_branch, branch_name, status,
          priority, auto_release, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
      `,
        )
        .run(
          taskId,
          taskNumber,
          idempotencyKey,
          input.title,
          input.projectId,
          baseBranch,
          branchName,
          priority,
          input.autoRelease === false ? 0 : 1,
          timestamp,
          timestamp,
        );
      this.db
        .prepare(
          `
        INSERT INTO turns (id, task_id, sequence, user_message, status, priority, created_at)
        VALUES (?, ?, 1, ?, 'queued', ?, ?)
      `,
        )
        .run(turnId, taskId, input.message, priority, timestamp);
      this.attachUploads(input.attachments, taskId, turnId);
      const task = this.getTask(taskId);
      const turn = this.getTurn(turnId);
      queueMicrotask(() =>
        this.emit({
          taskId,
          turnId,
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

  listTurns() {
    return this.db
      .prepare("SELECT * FROM turns ORDER BY created_at DESC")
      .all()
      .map(turnFromRow);
  }

  listTaskTurns(taskId) {
    return this.db
      .prepare("SELECT * FROM turns WHERE task_id=? ORDER BY sequence")
      .all(taskId)
      .map(turnFromRow);
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

  assertNoPreservedWorkspace(taskId) {
    const latest = this.db
      .prepare(
        `
      SELECT turns.worker_id, turns.status AS turn_status, workers.status AS worker_status
      FROM turns
      LEFT JOIN workers ON workers.id=turns.worker_id
      WHERE turns.task_id=?
      ORDER BY turns.sequence DESC
      LIMIT 1
    `,
      )
      .get(taskId);
    if (
      latest &&
      ["failed", "cancelled", "interrupted"].includes(latest.turn_status) &&
      latest.worker_status === "attention"
    ) {
      throw new HttpError(
        409,
        "WORKSPACE_REQUIRES_ATTENTION",
        "The previous worker still contains a preserved workspace. Inspect and durably resolve it before releasing the worker and queuing another turn.",
      );
    }
  }

  appendTurn(taskId, input) {
    const task = this.getTask(taskId);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    if (["closed", "cancelled"].includes(task.status)) {
      throw new HttpError(
        409,
        "TASK_CLOSED",
        "Closed task cannot accept a new turn",
      );
    }
    if (this.hasActiveTurn(taskId)) {
      throw new HttpError(
        409,
        "TURN_ALREADY_PENDING",
        "This task already has an active or queued turn",
      );
    }
    this.assertNoPreservedWorkspace(taskId);
    const timestamp = now();
    const turnId = id("turn-");
    return this.transaction(() => {
      const sequence = Number(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM turns WHERE task_id=?",
          )
          .get(taskId).value,
      );
      const priority = input.priority ?? task.priority;
      this.db
        .prepare(
          `
        INSERT INTO turns (id, task_id, sequence, user_message, status, priority, created_at)
        VALUES (?, ?, ?, ?, 'queued', ?, ?)
      `,
        )
        .run(turnId, taskId, sequence, input.message, priority, timestamp);
      this.db
        .prepare(
          `UPDATE tasks SET status='queued', priority=?, updated_at=? WHERE id=?`,
        )
        .run(priority, timestamp, taskId);
      this.attachUploads(input.attachments, taskId, turnId);
      const turn = this.getTurn(turnId);
      queueMicrotask(() =>
        this.emit({
          taskId,
          turnId,
          type: "turn.queued",
          phase: "queue",
          message: `Turn ${sequence} entered the execution queue`,
          data: { position: this.queuePosition(turnId) },
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

  listTurnAttachments(turnId) {
    return this.db
      .prepare("SELECT * FROM attachments WHERE turn_id=? ORDER BY created_at")
      .all(turnId)
      .map(attachmentFromRow);
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
        const workerRow = this.db
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
          WHERE id=? AND status='ready' AND current_turn_id IS NULL
        `,
          )
          .run(candidate.id, timestamp, workerRow.id);
        this.db
          .prepare(`UPDATE tasks SET status='running', updated_at=? WHERE id=?`)
          .run(timestamp, candidate.task_id);
        return this.getExecutionContext(candidate.id);
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
    return { task, turn, worker, project, attachments };
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

  completeTurn(turnId, { codexFinal, commitSha }) {
    const turn = this.getTurn(turnId);
    if (!turn) return null;
    const timestamp = now();
    this.transaction(() => {
      this.db
        .prepare(
          `
        UPDATE turns SET status='success', codex_final_json=?, commit_sha=?,
          error_code=NULL, error_message=NULL, finished_at=? WHERE id=?
      `,
        )
        .run(stringifyJson(codexFinal), commitSha || null, timestamp, turnId);
      this.db
        .prepare(
          `
        UPDATE tasks SET status='waiting_user', latest_commit_sha=COALESCE(?, latest_commit_sha), updated_at=?
        WHERE id=?
      `,
        )
        .run(commitSha || null, timestamp, turn.taskId);
    });
    return this.getTurn(turnId);
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
      this.db
        .prepare(`UPDATE tasks SET status='failed', updated_at=? WHERE id=?`)
        .run(timestamp, turn.taskId);
      if (turn.workerId) {
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

  cancelCurrentTurn(taskId) {
    const task = this.getTask(taskId);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    const row = this.db
      .prepare(
        `
      SELECT * FROM turns WHERE task_id=? AND status IN ('queued','preparing','running','saving','cancel_requested')
      ORDER BY sequence DESC LIMIT 1
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
      this.db
        .prepare(
          `UPDATE tasks SET status='waiting_user', updated_at=? WHERE id=?`,
        )
        .run(timestamp, taskId);
      if (turn.workerId && !wasQueued) {
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
      type: "turn.cancelled",
      level: "warning",
      phase: "cancelled",
      message: wasQueued
        ? "Current queued turn was removed; task history is preserved"
        : "Current turn was cancelled; worker workspace is preserved for inspection",
    });
    return { turn: this.getTurn(turn.id), preserveWorker: !wasQueued };
  }

  retryTask(taskId) {
    const task = this.getTask(taskId);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    if (this.hasActiveTurn(taskId))
      throw new HttpError(
        409,
        "TURN_ALREADY_PENDING",
        "Task already has an active turn",
      );
    this.assertNoPreservedWorkspace(taskId);
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
    return this.appendTurn(taskId, {
      message: latest.user_message,
      priority: latest.priority,
    });
  }

  closeTask(taskId) {
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
      type: "task.closed",
      message: `Task #${task.number} closed; conversation and branch remain available`,
    });
    return this.getTask(taskId);
  }

  reopenTask(taskId) {
    const task = this.getTask(taskId);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    if (task.status !== "closed")
      throw new HttpError(409, "TASK_NOT_CLOSED", "Task is not closed");
    this.db
      .prepare(
        `UPDATE tasks SET status='waiting_user', closed_at=NULL, updated_at=? WHERE id=?`,
      )
      .run(now(), taskId);
    this.emit({
      taskId,
      type: "task.reopened",
      message: `Task #${task.number} reopened`,
    });
    return this.getTask(taskId);
  }

  snapshot() {
    const projects = this.listProjects();
    const workers = this.listWorkers();
    const turns = this.listTurns();
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
      queue,
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
      },
    };
  }
}
