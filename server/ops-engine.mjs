import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexSessionRunner } from "./codex-session.mjs";
import {
  actionPolicyPrompt,
  suppressUnauthorizedActions,
} from "./ops-policy.mjs";
import { HttpError } from "./util.mjs";

const opsSchemaPath = fileURLToPath(
  new URL("./ops-output.schema.json", import.meta.url),
);
const recoverySchemaPath = fileURLToPath(
  new URL("./recovery-output.schema.json", import.meta.url),
);

const SUPERVISED_TASK_STATUSES = new Set(["queued", "running", "failed"]);

const INCIDENT_EVENT_TYPES = new Set([
  "turn.failed",
  "turn.release-failed",
  "worker.action.failed",
  "worker.unhealthy",
  "system.runtime.unhealthy",
  "guardian.health.failed",
  "guardian.restart.failed",
  "checkpoint.maintenance.failed",
]);

const INCIDENT_RECOVERY_EVENT_TYPES = new Map([
  [
    "guardian.health.recovered",
    new Set(["guardian.health.failed", "guardian.restart.failed"]),
  ],
  [
    "checkpoint.maintenance.completed",
    new Set(["checkpoint.maintenance.failed"]),
  ],
]);

function normalizedFingerprintPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, "<id>")
    .replace(/\b[0-9a-f]{12,40}\b/giu, "<sha>")
    .replace(/\b\d{2,}\b/gu, "<n>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

function incidentFingerprint(event) {
  return [
    event.type,
    event.taskId || "",
    event.workerId || "",
    event.data?.code || "",
    normalizedFingerprintPart(event.message),
  ].join("|");
}

function codexAgentMessage(event) {
  if (event?.type !== "item.completed") return null;
  if (event?.item?.type !== "agent_message") return null;
  return String(event.item.text || event.item.message || "").trim() || null;
}

function recoveryProgressMessage(event) {
  const agentMessage = codexAgentMessage(event);
  if (agentMessage) return agentMessage;
  if (!["item.started", "item.completed"].includes(event?.type)) return null;
  const item = event.item;
  if (item?.type !== "command_execution") return null;
  const command = String(item.command || "")
    .trim()
    .slice(0, 2_000);
  if (event.type === "item.started") {
    return command ? `执行恢复命令：${command}` : "正在执行恢复命令";
  }
  const output = String(item.aggregated_output || "")
    .trim()
    .slice(-4_000);
  return [
    `恢复命令${item.status === "completed" ? "已完成" : "已结束"}${item.exit_code == null ? "" : `（exit ${item.exit_code}）`}`,
    output || null,
  ]
    .filter(Boolean)
    .join("\n");
}

function safeJson(value, limit = 180_000) {
  const raw = JSON.stringify(value, null, 2);
  return raw.length > limit
    ? `${raw.slice(0, limit)}\n[context truncated]`
    : raw;
}

function promptIntegrityExtends(beforeIntegrity, afterIntegrity) {
  if (!beforeIntegrity || !afterIntegrity?.intact) return false;
  const beforeArchive = Array.isArray(beforeIntegrity.archive)
    ? beforeIntegrity.archive
    : [];
  const afterArchive = Array.isArray(afterIntegrity.archive)
    ? afterIntegrity.archive
    : [];
  if (afterArchive.length < beforeArchive.length) return false;
  return beforeArchive.every(
    (entry, index) =>
      JSON.stringify(afterArchive[index]) === JSON.stringify(entry),
  );
}

function recentLogExcerpts(logDirectory) {
  const collected = [];
  const visit = (directory, depth = 0) => {
    if (depth > 2 || collected.length >= 8) return;
    let entries = [];
    try {
      entries = fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .reverse();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (collected.length >= 8) break;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, depth + 1);
      else if (/\.(?:log|jsonl|txt)$/iu.test(entry.name)) {
        try {
          const stat = fs.statSync(target);
          const length = Math.min(8_000, stat.size);
          const handle = fs.openSync(target, "r");
          const buffer = Buffer.alloc(length);
          fs.readSync(
            handle,
            buffer,
            0,
            length,
            Math.max(0, stat.size - length),
          );
          fs.closeSync(handle);
          collected.push({
            path: target,
            tail: buffer.toString("utf8"),
            updatedAt: stat.mtime.toISOString(),
          });
        } catch {
          // A concurrently rotating log is not an incident by itself.
        }
      }
    }
  };
  visit(logDirectory);
  return collected
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);
}

export class OpsEngine {
  constructor(
    {
      config,
      store,
      scheduler,
      repairManager,
      restartCoordinator = null,
      checkpointMaintenance = null,
    },
    { sessionRunner = null, recoverySessionRunner = null } = {},
  ) {
    this.config = config;
    this.store = store;
    this.scheduler = scheduler;
    this.repairManager = repairManager;
    this.restartCoordinator = restartCoordinator;
    this.checkpointMaintenance = checkpointMaintenance;
    this.sessionRunner = sessionRunner || new CodexSessionRunner(config);
    this.recoverySessionRunner =
      recoverySessionRunner || new CodexSessionRunner(config);
    this.running = false;
    this.stopping = false;
    this.pumping = false;
    this.activeTurns = new Map();
    this.activeControllers = new Map();
    this.executions = new Set();
    this.actionChain = Promise.resolve();
    this.unsubscribe = null;
    this.supervisorTimer = null;
    this.lastSupervisorCheckAt = null;
    this.nextSupervisorCheckAt = null;
  }

  status() {
    const openIncidents = this.store
      .listIncidents()
      .filter((incident) => !incident.resolvedAt);
    return {
      enabled: Boolean(this.config.opsEnabled),
      running: this.running,
      activeTurnId: this.activeTurns.values().next().value || null,
      activeTurnIds: [...this.activeTurns.values()],
      activeSessions: this.activeTurns.size,
      maxConcurrentSessions: Math.max(
        1,
        Number(this.config.opsMaxConcurrentSessions || 4),
      ),
      openIncidents: openIncidents.length,
      automaticHandling: Boolean(this.config.opsAutoHandle),
      automaticDeployment: Boolean(this.config.opsAutoDeploy),
      supervisor: {
        running: Boolean(this.supervisorTimer),
        intervalMs: this.supervisorIntervalMs(),
        model: this.config.opsCodexModel || "gpt-5.6-luna",
        reasoningEffort: this.config.opsCodexReasoningEffort || "max",
        repairModel: this.config.opsRepairCodexModel || "gpt-5.6-sol",
        repairReasoningEffort:
          this.config.opsRepairCodexReasoningEffort || "xhigh",
        activeTaskCount: this.supervisedTasks().length,
        lastCheckAt: this.lastSupervisorCheckAt,
        nextCheckAt: this.nextSupervisorCheckAt,
      },
    };
  }

  supervisorIntervalMs() {
    return Math.max(
      1_000,
      Number(this.config.opsSupervisorIntervalMs || 5 * 60 * 1000),
    );
  }

  supervisedTasks() {
    return this.store
      .listTasks()
      .filter((task) => SUPERVISED_TASK_STATUSES.has(task.status));
  }

  async start() {
    if (this.running || !this.config.opsEnabled) return;
    this.running = true;
    this.stopping = false;
    this.store.ensureOpsThread();
    this.store.updateOpsThread("ops-system", {
      codexModel: this.config.opsCodexModel || "gpt-5.6-luna",
      codexReasoningEffort: this.config.opsCodexReasoningEffort || "max",
      codexFastMode: Boolean(this.config.opsCodexFastMode),
    });
    this.unsubscribe = this.store.onEvent((event) => this.onEvent(event));
    this.scanExistingProblems();
    this.scheduleNextSupervisorCheck();
    this.supervisorTimer = setInterval(() => {
      void this.runSupervisorCheck();
    }, this.supervisorIntervalMs());
    this.supervisorTimer.unref?.();
    this.pump();
  }

  stop() {
    this.running = false;
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.supervisorTimer) clearInterval(this.supervisorTimer);
    this.supervisorTimer = null;
    this.nextSupervisorCheckAt = null;
    for (const controller of this.activeControllers.values()) {
      controller.abort(
        Object.assign(
          new Error("Relay is stopping; recovery will resume after restart"),
          { code: "OPS_ENGINE_STOPPING" },
        ),
      );
    }
  }

  waitForIdle(timeoutMs = 15_000) {
    if (this.executions.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const timer = setInterval(() => {
        if (this.executions.size === 0 || Date.now() >= deadline) {
          clearInterval(timer);
          resolve(this.executions.size === 0);
        }
      }, 25);
    });
  }

  scheduleNextSupervisorCheck() {
    this.nextSupervisorCheckAt = new Date(
      Date.now() + this.supervisorIntervalMs(),
    ).toISOString();
  }

  runSupervisorCheck({ force = false } = {}) {
    if (!this.running) return null;
    this.lastSupervisorCheckAt = new Date().toISOString();
    this.scheduleNextSupervisorCheck();
    const tasks = this.supervisedTasks();
    if (!tasks.length) return null;
    const activeSystemTurn = this.store
      .listOpsTurns({ threadId: "ops-system", includeCleared: true })
      .some((turn) => ["queued", "running"].includes(turn.status));
    if (activeSystemTurn && !force) return null;
    const message = [
      "Five-minute persistent supervisor check.",
      "Check for concrete loss of progress, not missing audit paperwork. Leave normally queued and actively progressing tasks alone.",
      "Send task-level validation, delivery, and structured-result corrections to the original task Codex. Do not repeat full acceptance checklists or create a competing repair conversation.",
      "Use a separate recovery conversation only when infrastructure prevents the original task Codex from starting or resuming.",
      ...tasks.map(
        (task) =>
          `Task #${task.number} ${task.id}: status=${task.status}; branch=${task.branchName}; updatedAt=${task.updatedAt}`,
      ),
    ].join("\n");
    const turn = this.store.appendOpsTurn({
      message,
      trigger: "monitor",
      authorName: "Relay 5-minute Supervisor",
      threadId: "ops-system",
    });
    this.store.emit({
      opsTurnId: turn.id,
      actorName: "Relay 5-minute Supervisor",
      type: "ops.supervisor.check.queued",
      phase: "ops",
      message: `Persistent supervisor queued a check for ${tasks.length} non-terminal task(s)`,
      data: {
        taskIds: tasks.map((task) => task.id),
        intervalMs: this.supervisorIntervalMs(),
      },
    });
    this.pump();
    return turn;
  }

  scanExistingProblems() {
    for (const event of this.store.listEvents({ limit: 100 })) {
      if (INCIDENT_RECOVERY_EVENT_TYPES.has(event.type)) {
        this.resolveMonitoredIncidents(event);
        continue;
      }
      if (
        event.level === "error" &&
        !event.type.startsWith("ops.") &&
        (INCIDENT_EVENT_TYPES.has(event.type) || event.type === "turn.failed")
      ) {
        this.recordProblem(event);
      }
    }
    for (const worker of this.store.listWorkers()) {
      if (!worker.enabled || !["attention", "offline"].includes(worker.status))
        continue;
      if (
        this.store
          .listIncidents()
          .some(
            (incident) =>
              !incident.resolvedAt && incident.workerId === worker.id,
          )
      )
        continue;
      this.recordProblem({
        id: null,
        type: "worker.unhealthy",
        level: "error",
        taskId: null,
        turnId: worker.currentTurnId || null,
        workerId: worker.id,
        message:
          worker.lastError ||
          `Worker ${worker.name} is ${worker.status} and requires automatic recovery`,
        data: { status: worker.status, startupScan: true },
      });
    }
  }

  onEvent(event) {
    if (!this.running) return;
    if (
      event.type === "turn.delivered" ||
      event.type === "worker.action.completed" ||
      INCIDENT_RECOVERY_EVENT_TYPES.has(event.type)
    ) {
      this.resolveMonitoredIncidents(event);
      return;
    }
    if (event.actorName === "Relay Ops Codex" || event.type.startsWith("ops."))
      return;
    if (event.level !== "error" && !INCIDENT_EVENT_TYPES.has(event.type))
      return;
    this.recordProblem(event);
  }

  resolveMonitoredIncidents(event) {
    const recoveredSourceTypes = INCIDENT_RECOVERY_EVENT_TYPES.get(event.type);
    for (const incident of this.store.listIncidents()) {
      if (incident.resolvedAt) continue;
      const sameRecoveryKind = Boolean(
        recoveredSourceTypes?.has(incident.context?.eventType),
      );
      if (incident.status !== "monitoring" && !sameRecoveryKind) continue;
      const sameTask = event.taskId && incident.taskId === event.taskId;
      const sameWorker = event.workerId && incident.workerId === event.workerId;
      const sameRecoveryTarget = Boolean(
        sameRecoveryKind &&
        (!incident.taskId || sameTask) &&
        (!incident.workerId || sameWorker),
      );
      if (!sameTask && !sameWorker && !sameRecoveryTarget) continue;
      this.store.updateIncident(incident.id, {
        status: "resolved",
        lastAction: event.type,
        resolved: true,
      });
      this.store.emit({
        taskId: incident.taskId,
        workerId: incident.workerId,
        incidentId: incident.id,
        type: "ops.incident.resolved",
        phase: "ops",
        message: `Automatic recovery verified by ${event.type}`,
      });
    }
  }

  recordProblem(event) {
    const monitoring = this.store
      .listIncidents()
      .find(
        (incident) =>
          !incident.resolvedAt &&
          incident.status === "monitoring" &&
          ((event.taskId && incident.taskId === event.taskId) ||
            (event.workerId && incident.workerId === event.workerId)),
      );
    const result = this.store.createIncident({
      fingerprint: incidentFingerprint(event),
      severity: event.level === "warning" ? "warning" : "error",
      sourceEventId: event.id,
      canonicalIncidentId: monitoring?.id || null,
      reopenExisting: Boolean(monitoring),
      taskId: event.taskId,
      turnId: event.turnId,
      workerId: event.workerId,
      title: `${event.type}: ${String(event.message || "Relay incident").slice(0, 180)}`,
      error: event.message || event.type,
      context: {
        eventType: event.type,
        eventData: event.data || null,
        observedAt: event.createdAt || new Date().toISOString(),
      },
    });
    const { incident } = result;
    const hasSourceEvent =
      event.id != null && String(event.id).trim().length > 0;
    const duplicateSourceEvent =
      hasSourceEvent && result.sourceEventClaimed === false;
    if (!duplicateSourceEvent) {
      this.store.emit({
        taskId: incident.taskId,
        turnId: incident.turnId,
        workerId: incident.workerId,
        incidentId: incident.id,
        type: result.created ? "ops.incident.created" : "ops.incident.updated",
        phase: "ops",
        level: "warning",
        message: `System Codex captured incident: ${incident.title}`,
      });
    }
    if (
      this.config.opsAutoHandle &&
      !incident.resolvedAt &&
      incident.attemptCount < this.config.opsMaxAttempts &&
      !["queued", "diagnosing", "acting"].includes(incident.status)
    ) {
      this.queueIncident(incident, null, event.id);
    }
  }

  queueIncident(incident, followup = null, sourceEventId = null) {
    const task = incident.taskId ? this.store.getTask(incident.taskId) : null;
    const worker = incident.workerId
      ? this.store.getWorker(incident.workerId)
      : null;
    const message = [
      "Automatically diagnose and recover this Relay incident now.",
      `Incident ${incident.id}: ${incident.title}`,
      `Error: ${incident.error}`,
      task ? `Affected task: #${task.number} ${task.title}` : null,
      worker ? `Affected worker: ${worker.name} (${worker.status})` : null,
      followup ? `Previous action result: ${followup}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    if (followup) {
      this.store.appendOpsTurn({
        message,
        trigger: "followup",
        incidentId: incident.id,
        authorName: "Relay Auto Recovery",
      });
    } else {
      this.store.appendAutoRecoveryTurn({
        message,
        incidentId: incident.id,
        sourceEventId,
        authorName: "Relay Auto Recovery",
      });
    }
    void this.pump();
  }

  sendMessage(message, authorName = "Relay Operator", threadId = "ops-system") {
    if (!this.config.opsEnabled) {
      throw new HttpError(
        409,
        "OPS_DISABLED",
        "System Codex is disabled by configuration",
      );
    }
    const turn = this.store.appendOpsTurn({
      message,
      trigger: "manual",
      authorName,
      threadId,
    });
    this.pump();
    return turn;
  }

  pump() {
    if (!this.running || this.pumping) return;
    this.pumping = true;
    try {
      const maxConcurrentSessions = Math.max(
        1,
        Number(this.config.opsMaxConcurrentSessions || 4),
      );
      while (this.running && this.activeTurns.size < maxConcurrentSessions) {
        const turn = this.store.claimNextOpsTurn();
        if (!turn) break;
        const controller = new AbortController();
        this.activeTurns.set(turn.threadId, turn.id);
        this.activeControllers.set(turn.id, controller);
        const execution = this.runTurn(turn, controller);
        this.executions.add(execution);
        void execution.finally(() => this.executions.delete(execution));
      }
    } finally {
      this.pumping = false;
    }
  }

  async runTurn(turn, controller) {
    try {
      await this.execute(turn, controller.signal);
    } finally {
      this.activeTurns.delete(turn.threadId);
      this.activeControllers.delete(turn.id);
      queueMicrotask(() => this.pump());
    }
  }

  serializeAction(operation) {
    const execution = this.actionChain.then(operation, operation);
    this.actionChain = execution.catch(() => undefined);
    return execution;
  }

  buildContext(turn) {
    const snapshot = this.store.snapshot();
    const supervisedTasks = snapshot.tasks.filter((task) =>
      SUPERVISED_TASK_STATUSES.has(task.status),
    );
    const incident = turn.incidentId
      ? this.store.getIncident(turn.incidentId)
      : null;
    const relatedTask = incident?.taskId
      ? this.store.getTask(incident.taskId)
      : null;
    const relatedTurns = incident?.taskId
      ? this.store.listTaskTurns(incident.taskId)
      : snapshot.turns.slice(0, 30);
    return {
      request: turn.userMessage,
      incident,
      relatedTask,
      relatedTurns,
      relatedWorker: incident?.workerId
        ? this.store.getWorker(incident.workerId)
        : null,
      scheduler: this.scheduler.status(),
      runtime: this.scheduler.runtimeStatus(),
      checkpointMaintenance: this.checkpointMaintenance?.status?.() || null,
      workers: snapshot.workers,
      recentTasks: snapshot.tasks.slice(0, 30),
      supervisedTasks: supervisedTasks.map((task) => ({
        ...task,
        prompts: this.store.getTaskPromptArchive(task.id),
      })),
      activeRecoveryTurns: this.store
        .listOpsTurns({ includeCleared: true })
        .filter(
          (item) =>
            item.trigger === "repair" &&
            ["queued", "running"].includes(item.status),
        ),
      recentEvents: snapshot.events.slice(-100),
      openIncidents: snapshot.ops.incidents.filter((item) => !item.resolvedAt),
      recentLogs: recentLogExcerpts(this.config.logDirectory),
    };
  }

  buildPrompt(turn) {
    const context = this.buildContext(turn);
    return [
      "You are the persistent Relay system operations Codex.",
      "You are the always-on five-minute supervisor, not the hands-on repair agent.",
      "Your durable Codex thread is resumed on every check so you must carry forward prior observations and compare them with current evidence.",
      "Your job is to diagnose any Relay, Hyper-V worker, Unity task, Git delivery, web, Guardian, or Relay-code incident.",
      "For each non-terminal task, distinguish normal long-running work from a real stall using task detail, persistent JSONL progress, Worker/Unity health, Git evidence, and delivery state.",
      "Do not declare a task stuck merely because it is slow. Require concrete stale or contradictory evidence.",
      "Task validation, delivery audit, Unity save, Git finalization, and structured blocked results belong to the original task Codex conversation. Use task.continue with a concise error and success condition; do not open a repair conversation for them.",
      "Use codex.repair only when concrete evidence proves the original task Codex could not start or resume because the worker, runtime, or workspace ownership infrastructure failed before Codex produced a result.",
      "Describe only the evidence, fault, and required success condition. Avoid duplicating audits, policy restatements, or large context already present in the immutable task prompt.",
      "The complete immutable task prompt archive in the context is authoritative. Never replace, shorten, rewrite, or lose it.",
      ...actionPolicyPrompt(turn),
      "For an attention worker with a preserved failed task, prefer task.continue with precise recovery instructions so the same Codex thread and workspace are resumed without reset.",
      "Use worker.release only when delivery is already durable. Use worker.restart for infrastructure faults, not to discard uncommitted task work.",
      "For checkpoint-maintenance incidents, use checkpoint.refresh only after the evidence shows the entire Relay task queue is empty, the worker is idle, and the failure is safely retryable. The action atomically rechecks queued and executing turns plus worker readiness, and never touches a busy or attention workspace. Use codex.repair only for a pre-Codex infrastructure failure that prevents the original task conversation from running.",
      "Checkpoint-maintenance invariant: never add, commit, or push guest-local .meta drift. The configured remote base branch is authoritative. The guarded refresh restores only pure unstaged Unity-generated .meta drift; if any non-.meta, staged, renamed, or copied work is present, preserve the entire workspace and keep the maintenance gate closed.",
      "Never delete or manipulate AVHDX/VHDX files. Checkpoint rotation is allowed only through the checkpoint maintenance action, which creates and canary-verifies the new PROJECT_READY before pruning the oldest managed checkpoint.",
      "If Relay code is the root cause, use relay.repair with a complete repair instruction. It creates an isolated worktree, rejects file deletions, validates, commits, fast-forwards, and asks Guardian to restart.",
      "Use relay.restart or web.restart when code changes are unnecessary. Mark an incident resolved only when the supplied state already proves recovery.",
      "",
      "Current authoritative context:",
      safeJson(context),
    ].join("\n");
  }

  emit(turn, message, level = "info", data = null) {
    this.store.emit({
      opsTurnId: turn.id,
      incidentId: turn.incidentId,
      type: "ops.codex.message",
      phase: "ops",
      level,
      message,
      data,
    });
  }

  async execute(turn, signal) {
    if (turn.trigger === "repair") {
      await this.executeRecoveryTurn(turn, signal);
      return;
    }
    const thread = this.store.getOpsThread(turn.threadId);
    if (!thread) {
      this.store.failOpsTurn(
        turn.id,
        Object.assign(new Error("System Codex conversation not found"), {
          code: "OPS_THREAD_NOT_FOUND",
        }),
      );
      return;
    }
    this.emit(turn, "System Codex is diagnosing the current state");
    try {
      const result = await this.sessionRunner.run({
        cwd: this.config.projectRoot,
        threadId: thread.codexThreadId,
        prompt: this.buildPrompt(turn),
        schemaPath: opsSchemaPath,
        logDirectory: path.join(this.config.logDirectory, "ops", "turns"),
        logName: `${turn.sequence}-${turn.id}`,
        sandbox: "read-only",
        model: thread.codexModel,
        reasoningEffort: thread.codexReasoningEffort,
        fastMode: thread.codexFastMode,
        signal,
        onEvent: (event) => {
          if (event?.type === "thread.started") {
            this.store.setOpsCodexThread(
              turn.threadId,
              event.thread_id || event.threadId || event.thread?.id,
            );
          }
          const message = codexAgentMessage(event);
          if (message) this.emit(turn, message);
        },
      });
      this.store.setOpsCodexThread(turn.threadId, result.threadId);
      const policy = suppressUnauthorizedActions(turn, result.final);
      const actionResults = [];
      let pending = false;
      let failed = false;
      if (policy.suppressed.length) {
        actionResults.push(...policy.suppressed);
        this.store.emit({
          opsTurnId: turn.id,
          incidentId: turn.incidentId,
          actorName: "Relay Ops Policy",
          type: "ops.action.suppressed",
          phase: "ops-action",
          level: "warning",
          message: `Kept manual diagnosis read-only; suppressed ${policy.suppressed.length} unauthorized action(s)`,
          data: {
            reason: "manual_action_not_authorized",
            actions: policy.suppressed.map((action) => action.type),
          },
        });
      }
      if (turn.incidentId && policy.actions.length) {
        this.store.updateIncident(turn.incidentId, {
          status: "acting",
          lastAction: policy.actions[0].type,
        });
      }
      for (const proposed of policy.actions) {
        const execution = await this.serializeAction(() =>
          this.executeAction(turn, proposed, policy.final),
        );
        actionResults.push(execution);
        pending ||= Boolean(execution.pending);
        failed ||= execution.status === "failed";
      }
      const final = { ...policy.final, actionResults };
      this.store.completeOpsTurn(turn.id, final);
      this.emit(turn, policy.final.summary, failed ? "error" : "info", {
        status: policy.final.status,
        actions: actionResults.length,
      });

      if (turn.incidentId) {
        const incident = this.store.getIncident(turn.incidentId);
        if (failed) {
          this.store.updateIncident(turn.incidentId, {
            status: "open",
            error: actionResults
              .filter((item) => item.status === "failed")
              .map((item) => item.error)
              .join("; "),
          });
          if (incident.attemptCount < this.config.opsMaxAttempts) {
            this.queueIncident(
              this.store.getIncident(turn.incidentId),
              "One or more proposed actions failed; choose another non-deleting recovery",
            );
          }
        } else if (pending || policy.final.status === "monitoring") {
          this.store.updateIncident(turn.incidentId, {
            status: "monitoring",
          });
        } else {
          this.store.updateIncident(turn.incidentId, {
            status: "resolved",
            resolved: true,
          });
        }
      }
    } catch (error) {
      this.store.failOpsTurn(turn.id, error);
      this.emit(turn, error?.message || String(error), "error", {
        code: error?.code || "OPS_TURN_FAILED",
      });
      const incident = turn.incidentId
        ? this.store.getIncident(turn.incidentId)
        : null;
      if (incident && incident.attemptCount < this.config.opsMaxAttempts) {
        const reopened = this.store.reopenIncident(
          incident.id,
          error?.message || String(error),
        );
        this.queueIncident(
          reopened,
          `System Codex execution failed: ${error?.message || String(error)}`,
        );
      }
    }
  }

  buildRecoveryPrompt(turn) {
    const task = turn.targetTaskId
      ? this.store.getTask(turn.targetTaskId)
      : null;
    const promptIntegrity = task
      ? this.store.verifyTaskPromptIntegrity(task.id)
      : null;
    const taskTurns = task ? this.store.listTaskTurns(task.id) : [];
    const snapshot = this.store.snapshot();
    return [
      "You are a fresh unrestricted Relay recovery Codex running directly on the Windows host.",
      "Use the same level of initiative and machine access as an interactive Codex desktop conversation.",
      "You are not limited to the Relay structured action catalog or to a read-only diagnosis. Use shell commands, PowerShell Direct, local APIs, Git, Unity endpoints, service controls, and source edits as needed.",
      "Work continuously until the underlying fault is repaired and the original user task has actually started again, or until a genuine external/user-only blocker is proven.",
      "Do not return merely because you found a likely cause or launched an asynchronous action. Inspect its result, repair follow-on failures, and verify the task state.",
      "The one non-negotiable invariant is task-prompt preservation: never delete, replace, shorten, rewrite, or summarize away the original task title, any user turn, or its attachment references.",
      "Continue the existing Task and Codex thread/workspace whenever they exist. Do not create a replacement task as a shortcut.",
      "Once the original task Codex is running and producing progress, return immediately. Do not concurrently edit its workspace, drive its Unity session, poll it to completion, or redo its task acceptance. Task-level corrections belong in that original conversation.",
      "A database-level immutable archive protects every prompt. Confirm its fingerprint before and after recovery.",
      "Treat the supervisor's recovery assignment as diagnostic context and a required outcome, not as an extra action restriction. Unless a constraint comes from the immutable user prompt, current user authorization, or platform policy, choose any repair method and use any available tool.",
      "For checkpoint-maintenance recovery, never add, commit, or push guest-local .meta drift. Treat the configured remote base branch as authoritative and use the guarded checkpoint refresh to restore pure unstaged Unity-generated .meta-only drift. Preserve and report the entire workspace instead if any non-.meta, staged, renamed, or copied change is present.",
      "If Relay itself must restart, make the change durable and use the normal Guardian-controlled restart. This recovery turn is re-queued after Relay restart and will resume the same Codex conversation.",
      "Follow platform safety rules and the user's authorized scope, but do not impose the old Ops action-catalog, read-only sandbox, or no-op diagnosis restrictions on yourself.",
      "",
      `Recovery assignment:\n${turn.userMessage}`,
      "",
      task
        ? `Target task:\n${JSON.stringify(
            {
              task,
              turns: taskTurns,
              immutablePromptArchive: promptIntegrity.archive,
              promptFingerprint: promptIntegrity.fingerprint,
            },
            null,
            2,
          )}`
        : "No single task was targeted; repair the Relay infrastructure fault described above.",
      "",
      `Current authoritative Relay snapshot:\n${safeJson(snapshot)}`,
    ].join("\n");
  }

  async waitForTaskRestart(taskId, signal) {
    const timeoutMs = Math.max(
      0,
      Number(this.config.opsRepairTaskStartWaitMs ?? 120_000),
    );
    const deadline = Date.now() + timeoutMs;
    let task = this.store.getTask(taskId);
    while (
      task &&
      task.status === "queued" &&
      Date.now() < deadline &&
      !signal?.aborted
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      task = this.store.getTask(taskId);
    }
    return task;
  }

  async ensureTaskRestarted(taskId, signal) {
    let task = this.store.getTask(taskId);
    if (!task) {
      throw Object.assign(
        new Error(`Recovery target task ${taskId} vanished`),
        {
          code: "RECOVERY_TASK_MISSING",
        },
      );
    }
    if (task.status === "failed" && !this.store.hasActiveTurn(taskId)) {
      this.scheduler.retryTask(taskId, "Relay Repair Codex");
      task = this.store.getTask(taskId);
    } else if (task.status === "queued") {
      this.scheduler.notifyQueueChanged();
    }
    if (task.status === "queued") {
      task = await this.waitForTaskRestart(taskId, signal);
    }
    return task;
  }

  async executeRecoveryTurn(turn, signal) {
    const thread = this.store.getOpsThread(turn.threadId);
    if (!thread) {
      this.store.failOpsTurn(
        turn.id,
        Object.assign(new Error("Recovery Codex conversation not found"), {
          code: "RECOVERY_THREAD_NOT_FOUND",
        }),
      );
      return;
    }
    // A recovery can sit in the queue (or be requeued across a restart) long
    // after its diagnosis went stale. Recheck before launching another writer.
    const targetTask = turn.targetTaskId
      ? this.store.getTask(turn.targetTaskId)
      : null;
    const targetTurns = targetTask
      ? this.store.listTaskTurns(targetTask.id)
      : [];
    const latestTargetTurn = targetTurns.at(-1);
    const originalTaskRunning = targetTurns.some((candidate) =>
      ["running", "saving"].includes(candidate.status),
    );
    if (
      targetTask &&
      (!SUPERVISED_TASK_STATUSES.has(targetTask.status) ||
        originalTaskRunning ||
        latestTargetTurn?.codexFinal)
    ) {
      const routing = this.queueRecoveryConversation(
        { ...turn, trigger: "monitor", incidentId: null },
        {
          targetId: targetTask.id,
          message: [
            "Resolve the latest task-level failure in this original conversation; validate only the requested change, proportionally.",
            latestTargetTurn?.errorMessage,
            latestTargetTurn?.codexFinal?.question,
          ]
            .filter(Boolean)
            .join("\n")
            .slice(0, 4000),
        },
        {
          diagnosis:
            "Rechecked a stale queued recovery against current task state.",
        },
      );
      this.store.completeOpsTurn(turn.id, {
        status: "completed",
        summary:
          "Stale separate recovery retired; the original task owns execution and task-level corrections.",
        routing,
      });
      this.emit(
        turn,
        "已收敛过期修复会话；原任务负责继续执行和任务内纠偏",
        "info",
        routing,
      );
      return;
    }
    const beforeIntegrity = turn.targetTaskId
      ? this.store.verifyTaskPromptIntegrity(turn.targetTaskId)
      : null;
    if (beforeIntegrity && !beforeIntegrity.intact) {
      this.store.failOpsTurn(
        turn.id,
        Object.assign(
          new Error(
            `Task prompt integrity was already broken before recovery ${turn.id}`,
          ),
          { code: "TASK_PROMPT_INTEGRITY_BROKEN" },
        ),
      );
      return;
    }
    this.emit(turn, "新的 GPT-5.6 Sol xhigh 全权限修复对话已启动", "info", {
      targetTaskId: turn.targetTaskId,
      promptFingerprint: beforeIntegrity?.fingerprint || null,
    });
    try {
      const result = await this.recoverySessionRunner.run({
        cwd: this.config.projectRoot,
        threadId: thread.codexThreadId,
        prompt: this.buildRecoveryPrompt(turn),
        schemaPath: recoverySchemaPath,
        logDirectory: path.join(
          this.config.logDirectory,
          "ops",
          "recoveries",
          turn.id,
        ),
        logName: "codex",
        sandbox: "danger-full-access",
        model: this.config.opsRepairCodexModel || "gpt-5.6-sol",
        reasoningEffort: this.config.opsRepairCodexReasoningEffort || "xhigh",
        fastMode: Boolean(this.config.opsRepairCodexFastMode),
        timeoutMs: Number(this.config.opsRepairCodexTimeoutMs || 0),
        signal,
        onEvent: (event) => {
          if (event?.type === "thread.started") {
            this.store.setOpsCodexThread(
              turn.threadId,
              event.thread_id || event.threadId || event.thread?.id,
            );
          }
          const message = recoveryProgressMessage(event);
          if (message) this.emit(turn, message);
        },
      });
      this.store.setOpsCodexThread(turn.threadId, result.threadId);
      const afterIntegrity = turn.targetTaskId
        ? this.store.verifyTaskPromptIntegrity(turn.targetTaskId)
        : null;
      if (
        afterIntegrity &&
        !promptIntegrityExtends(beforeIntegrity, afterIntegrity)
      ) {
        throw Object.assign(
          new Error(
            `Recovery ${turn.id} changed or removed protected task prompt data; the immutable archive remains available for recovery`,
          ),
          { code: "TASK_PROMPT_INTEGRITY_CHANGED" },
        );
      }
      const task =
        turn.targetTaskId && result.final.status === "completed"
          ? await this.ensureTaskRestarted(turn.targetTaskId, signal)
          : turn.targetTaskId
            ? this.store.getTask(turn.targetTaskId)
            : null;
      const taskStarted =
        !task ||
        ["running", "waiting_user", "closed"].includes(task.status) ||
        (task.status === "queued" && this.store.hasActiveTurn(task.id));
      const final = {
        ...result.final,
        status:
          result.final.status === "completed" && !taskStarted
            ? "monitoring"
            : result.final.status,
        promptIntegrity: afterIntegrity
          ? {
              intact: afterIntegrity.intact,
              startedFingerprint: beforeIntegrity.fingerprint,
              fingerprint: afterIntegrity.fingerprint,
              archivedTurns: afterIntegrity.archivedTurns,
              addedArchivedTurns: Math.max(
                0,
                afterIntegrity.archivedTurns - beforeIntegrity.archivedTurns,
              ),
            }
          : null,
        taskState: task
          ? {
              id: task.id,
              number: task.number,
              status: task.status,
              codexThreadId: task.codexThreadId,
              branchName: task.branchName,
            }
          : null,
      };
      this.store.completeOpsTurn(turn.id, final);
      this.emit(
        turn,
        taskStarted
          ? "修复对话已完成，原任务提示词完整且任务已恢复到可运行状态"
          : "修复对话已结束，但原任务尚未启动；五分钟监督会继续追踪",
        taskStarted ? "info" : "warning",
        {
          status: final.status,
          targetTaskId: turn.targetTaskId,
          taskStatus: task?.status || null,
          promptFingerprint: afterIntegrity?.fingerprint || null,
        },
      );
    } catch (error) {
      if (this.stopping && error?.code === "OPS_ENGINE_STOPPING") {
        this.store.requeueOpsTurn(
          turn.id,
          "Relay is restarting; this unrestricted recovery conversation will resume",
        );
        return;
      }
      this.store.failOpsTurn(turn.id, error);
      this.emit(turn, error?.message || String(error), "error", {
        code: error?.code || "RECOVERY_TURN_FAILED",
        targetTaskId: turn.targetTaskId,
        promptFingerprint: beforeIntegrity?.fingerprint || null,
      });
      if (turn.incidentId) {
        this.store.reopenIncident(
          turn.incidentId,
          error?.message || String(error),
        );
      }
    }
  }

  queueRecoveryConversation(turn, action, diagnosis) {
    const incident = turn.incidentId
      ? this.store.getIncident(turn.incidentId)
      : null;
    const targetTaskId =
      (action.targetId && this.store.getTask(action.targetId)?.id) ||
      incident?.taskId ||
      null;
    const task = targetTaskId ? this.store.getTask(targetTaskId) : null;
    if (
      turn.trigger === "monitor" &&
      !turn.incidentId &&
      task &&
      !SUPERVISED_TASK_STATUSES.has(task.status)
    ) {
      this.store.emit({
        taskId: targetTaskId,
        opsTurnId: turn.id,
        actorName: "Relay Persistent Supervisor",
        type: "ops.recovery.skipped",
        phase: "ops",
        message: `Skipped stale automatic recovery for terminal task #${task.number}`,
        data: {
          targetTaskId,
          taskStatus: task.status,
          reason: "target-left-supervised-state-before-action",
        },
      });
      return {
        pending: false,
        skipped: true,
        targetTaskId,
        taskStatus: task.status,
        reason: "target-left-supervised-state-before-action",
      };
    }
    if (task) {
      const taskTurns = this.store.listTaskTurns(task.id);
      const latestTaskTurn = taskTurns.at(-1) || null;
      const taskConversationStarted = taskTurns.some(
        (candidate) => candidate.codexFinal != null,
      );
      const activeTaskTurn = taskTurns.find((candidate) =>
        ["queued", "preparing", "running", "saving"].includes(candidate.status),
      );
      if (
        activeTaskTurn &&
        (taskConversationStarted ||
          ["running", "saving"].includes(activeTaskTurn.status))
      ) {
        this.store.emit({
          taskId: task.id,
          turnId: activeTaskTurn.id,
          opsTurnId: turn.id,
          actorName: "Relay Persistent Supervisor",
          type: "ops.recovery.skipped",
          phase: "ops",
          message: `Skipped a separate repair conversation because task #${task.number} is already continuing in its original Codex conversation`,
          data: {
            targetTaskId: task.id,
            taskTurnId: activeTaskTurn.id,
            reason: "original-task-conversation-active",
          },
        });
        return {
          pending: true,
          skipped: true,
          targetTaskId: task.id,
          taskTurnId: activeTaskTurn.id,
          reason: "original-task-conversation-active",
        };
      }
      if (latestTaskTurn?.codexFinal) {
        if (
          latestTaskTurn.authorName === "Relay Task Feedback" ||
          latestTaskTurn.codexFinal.status === "needs_input"
        ) {
          const reason =
            latestTaskTurn.codexFinal.status === "needs_input"
              ? "task-awaiting-user-input"
              : "task-feedback-already-attempted";
          this.store.emit({
            taskId: task.id,
            turnId: latestTaskTurn.id,
            opsTurnId: turn.id,
            actorName: "Relay Persistent Supervisor",
            type: "ops.recovery.skipped",
            phase: "ops",
            message: `Task #${task.number} requires monitoring or user input; preserving its original conversation instead of creating a repair conversation`,
            data: {
              targetTaskId: task.id,
              taskTurnId: latestTaskTurn.id,
              reason,
            },
          });
          return {
            pending: false,
            skipped: true,
            targetTaskId: task.id,
            taskTurnId: latestTaskTurn.id,
            reason,
          };
        }
        const feedbackTurn = this.store.appendTurn(task.id, {
          message: [
            "Continue the original task in this same Codex conversation and preserved workspace.",
            action.message || diagnosis.diagnosis,
            action.reason ? `Reason: ${action.reason}` : null,
            diagnosis.verification
              ? `Success condition: ${diagnosis.verification}`
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
          priority: latestTaskTurn.priority,
          executionProfile: latestTaskTurn.executionProfile,
          userName: "Relay Task Feedback",
        });
        this.store.emit({
          taskId: task.id,
          turnId: feedbackTurn.id,
          opsTurnId: turn.id,
          actorName: "Relay Persistent Supervisor",
          type: "ops.recovery.rerouted",
          phase: "ops",
          message: `Rerouted recovery to task #${task.number}'s original Codex conversation`,
          data: {
            targetTaskId: task.id,
            taskTurnId: feedbackTurn.id,
            reason: "post-codex-failure-belongs-to-task",
          },
        });
        this.scheduler.notifyQueueChanged();
        return {
          pending: true,
          rerouted: true,
          targetTaskId: task.id,
          taskTurnId: feedbackTurn.id,
          reason: "post-codex-failure-belongs-to-task",
        };
      }
    }
    const active = this.store.findActiveRecoveryTurn(targetTaskId);
    if (active) {
      return {
        pending: true,
        deduplicated: true,
        recoveryTurnId: active.id,
        recoveryThreadId: active.threadId,
        targetTaskId,
      };
    }
    const recoveryThread = this.store.createOpsThread({
      title: task
        ? `自动修复 #${task.number} · ${new Date().toLocaleString("zh-CN")}`
        : `系统全权限修复 · ${new Date().toLocaleString("zh-CN")}`,
      codexModel: this.config.opsRepairCodexModel || "gpt-5.6-sol",
      codexReasoningEffort:
        this.config.opsRepairCodexReasoningEffort || "xhigh",
      codexFastMode: Boolean(this.config.opsRepairCodexFastMode),
    });
    const recoveryTurn = this.store.appendOpsTurn({
      threadId: recoveryThread.id,
      message: [
        action.message || diagnosis.diagnosis,
        `Supervisor reason: ${action.reason}`,
        `Required verification: ${diagnosis.verification}`,
      ]
        .filter(Boolean)
        .join("\n"),
      trigger: "repair",
      incidentId: turn.incidentId,
      targetTaskId,
      parentOpsTurnId: turn.id,
      authorName: "Relay Persistent Supervisor",
    });
    this.store.emit({
      taskId: targetTaskId,
      opsTurnId: recoveryTurn.id,
      incidentId: turn.incidentId,
      actorName: "Relay Persistent Supervisor",
      type: "ops.recovery.spawned",
      phase: "ops",
      message: task
        ? `Spawned unrestricted GPT-5.6 Sol xhigh recovery conversation for task #${task.number}`
        : "Spawned unrestricted GPT-5.6 Sol xhigh infrastructure recovery conversation",
      data: {
        parentOpsTurnId: turn.id,
        recoveryThreadId: recoveryThread.id,
        recoveryTurnId: recoveryTurn.id,
        targetTaskId,
      },
    });
    queueMicrotask(() => this.pump());
    return {
      pending: true,
      recoveryTurnId: recoveryTurn.id,
      recoveryThreadId: recoveryThread.id,
      targetTaskId,
    };
  }

  async executeAction(turn, proposed, diagnosis) {
    const action = this.store.createOpsAction({
      opsTurnId: turn.id,
      incidentId: turn.incidentId,
      type: proposed.type,
      targetId: proposed.targetId,
      message: proposed.message,
      reason: proposed.reason,
      reversible: true,
    });
    this.store.updateOpsAction(action.id, "running");
    this.store.emit({
      opsTurnId: turn.id,
      incidentId: turn.incidentId,
      actorName: "Relay Ops Codex",
      type: "ops.action.started",
      phase: "ops-action",
      message: `${proposed.type}: ${proposed.reason}`,
      data: { actionId: action.id, targetId: proposed.targetId },
    });
    try {
      const result = await this.performAction(turn, proposed, diagnosis);
      this.store.updateOpsAction(action.id, "completed", { result });
      this.store.emit({
        opsTurnId: turn.id,
        incidentId: turn.incidentId,
        actorName: "Relay Ops Codex",
        type: "ops.action.completed",
        phase: "ops-action",
        message: `${proposed.type} completed`,
        data: { actionId: action.id, result },
      });
      return {
        id: action.id,
        type: proposed.type,
        status: "completed",
        pending: Boolean(result?.pending),
        result,
      };
    } catch (error) {
      this.store.updateOpsAction(action.id, "failed", {
        error: error?.message || String(error),
      });
      this.store.emit({
        opsTurnId: turn.id,
        incidentId: turn.incidentId,
        actorName: "Relay Ops Codex",
        type: "ops.action.failed",
        phase: "ops-action",
        level: "error",
        message: `${proposed.type} failed: ${error?.message || String(error)}`,
        data: { actionId: action.id, code: error?.code || "OPS_ACTION_FAILED" },
      });
      return {
        id: action.id,
        type: proposed.type,
        status: "failed",
        error: error?.message || String(error),
      };
    }
  }

  async performAction(turn, action, diagnosis) {
    const incident = turn.incidentId
      ? this.store.getIncident(turn.incidentId)
      : null;
    const targetId =
      action.targetId ||
      (action.type.startsWith("task.") ? incident?.taskId : null) ||
      (action.type.startsWith("worker.") ? incident?.workerId : null) ||
      (action.type.startsWith("checkpoint.") ? incident?.workerId : null);
    const actorName = "Relay Ops Codex";
    switch (action.type) {
      case "task.continue": {
        if (!targetId)
          throw new HttpError(
            400,
            "OPS_TARGET_MISSING",
            "Task target is required",
          );
        const task = this.store.getTask(targetId);
        if (
          turn.trigger !== "manual" &&
          task &&
          !SUPERVISED_TASK_STATUSES.has(task.status)
        ) {
          return {
            pending: false,
            skipped: true,
            targetTaskId: task.id,
            reason: "target-left-supervised-state-before-action",
          };
        }
        const taskTurns = this.store.listTaskTurns(targetId);
        const activeTaskTurn = taskTurns.find((candidate) =>
          ["queued", "preparing", "running", "saving"].includes(
            candidate.status,
          ),
        );
        if (turn.trigger !== "manual" && activeTaskTurn) {
          return {
            pending: true,
            deduplicated: true,
            turnId: activeTaskTurn.id,
          };
        }
        const latestTaskTurn = taskTurns.at(-1);
        if (
          turn.trigger !== "manual" &&
          (latestTaskTurn?.authorName === "Relay Task Feedback" ||
            latestTaskTurn?.codexFinal?.status === "needs_input")
        ) {
          return {
            pending: false,
            skipped: true,
            turnId: latestTaskTurn.id,
            reason: "task-needs-monitoring-or-user-input",
          };
        }
        const queued = this.store.appendTurn(targetId, {
          message:
            action.message ||
            `Recover the preserved task after this failure: ${incident?.error || diagnosis.diagnosis}`,
          userName:
            turn.trigger === "manual" ? actorName : "Relay Task Feedback",
        });
        this.scheduler.notifyQueueChanged();
        return { pending: true, turnId: queued.id };
      }
      case "task.retry": {
        if (turn.trigger !== "manual") {
          return this.performAction(
            turn,
            { ...action, type: "task.continue", targetId },
            diagnosis,
          );
        }
        if (!targetId)
          throw new HttpError(
            400,
            "OPS_TARGET_MISSING",
            "Task target is required",
          );
        const queued = this.scheduler.retryTask(targetId, actorName);
        return { pending: true, turnId: queued.id };
      }
      case "task.reopen":
        if (!targetId)
          throw new HttpError(
            400,
            "OPS_TARGET_MISSING",
            "Task target is required",
          );
        return { task: this.store.reopenTask(targetId, actorName) };
      case "worker.probe":
      case "worker.start":
      case "worker.restart":
      case "worker.shutdown":
      case "worker.release": {
        if (!targetId)
          throw new HttpError(
            400,
            "OPS_TARGET_MISSING",
            "Worker target is required",
          );
        const workerAction = action.type.split(".")[1];
        const worker = await this.scheduler.controlWorker(
          targetId,
          workerAction,
          { actorName },
        );
        return { worker };
      }
      case "scheduler.pause":
        return { scheduler: this.scheduler.setPaused(true, actorName) };
      case "scheduler.resume":
        return { scheduler: this.scheduler.setPaused(false, actorName) };
      case "relay.repair": {
        const repair = await this.repairManager.run({
          opsTurnId: turn.id,
          incidentId: turn.incidentId,
          instructions:
            action.message ||
            `${diagnosis.diagnosis}\nRequired verification: ${diagnosis.verification}`,
        });
        return {
          pending: repair.status === "deployed",
          repairId: repair.id,
          status: repair.status,
          commitSha: repair.commitSha,
        };
      }
      case "relay.restart":
        await this.restartCoordinator?.requestRelayRestart?.({
          reason: action.reason,
        });
        return { pending: true };
      case "web.restart":
        await this.restartCoordinator?.requestWebRestart?.({
          reason: action.reason,
        });
        return { pending: true };
      case "guardian.restart":
        await this.restartCoordinator?.requestGuardianRestart?.({
          reason: action.reason,
        });
        return { pending: true };
      case "checkpoint.refresh": {
        if (!this.checkpointMaintenance) {
          throw new HttpError(
            503,
            "CHECKPOINT_MAINTENANCE_NOT_RUNNING",
            "Checkpoint maintenance is not running",
          );
        }
        const recoveryIncidentId =
          incident?.id &&
          incident.workerId === targetId &&
          !incident.resolvedAt &&
          incident.context?.eventType === "checkpoint.maintenance.failed"
            ? incident.id
            : null;
        const result = await this.checkpointMaintenance.runNow({
          workerId: targetId,
          reason: action.reason || diagnosis.diagnosis,
          ...(recoveryIncidentId ? { recoveryIncidentId } : {}),
        });
        if (!result?.ok) {
          throw Object.assign(
            new Error(
              result?.results
                ?.filter((item) => !item.ok)
                .map((item) => item.error)
                .join("; ") || "Checkpoint refresh did not complete",
            ),
            { code: "CHECKPOINT_REFRESH_FAILED", details: result },
          );
        }
        return result;
      }
      case "codex.repair":
        return this.queueRecoveryConversation(turn, action, diagnosis);
      case "incident.resolve":
        if (turn.incidentId) {
          this.store.updateIncident(turn.incidentId, {
            status: "resolved",
            resolved: true,
          });
        }
        return { resolved: true };
      default:
        throw new HttpError(
          400,
          "OPS_ACTION_UNSUPPORTED",
          `Unsupported Ops action: ${action.type}`,
        );
    }
  }
}
