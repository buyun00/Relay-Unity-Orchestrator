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

const INCIDENT_EVENT_TYPES = new Set([
  "turn.failed",
  "turn.release-failed",
  "worker.action.failed",
  "worker.unhealthy",
  "system.runtime.unhealthy",
  "guardian.health.failed",
  "guardian.restart.failed",
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

function safeJson(value, limit = 180_000) {
  const raw = JSON.stringify(value, null, 2);
  return raw.length > limit
    ? `${raw.slice(0, limit)}\n[context truncated]`
    : raw;
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
    { config, store, scheduler, repairManager, restartCoordinator = null },
    { sessionRunner = null } = {},
  ) {
    this.config = config;
    this.store = store;
    this.scheduler = scheduler;
    this.repairManager = repairManager;
    this.restartCoordinator = restartCoordinator;
    this.sessionRunner = sessionRunner || new CodexSessionRunner(config);
    this.running = false;
    this.pumping = false;
    this.activeTurns = new Map();
    this.actionChain = Promise.resolve();
    this.unsubscribe = null;
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
    };
  }

  async start() {
    if (this.running || !this.config.opsEnabled) return;
    this.running = true;
    this.store.ensureOpsThread();
    this.unsubscribe = this.store.onEvent((event) => this.onEvent(event));
    this.scanExistingProblems();
    this.pump();
  }

  stop() {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  scanExistingProblems() {
    for (const event of this.store.listEvents({ limit: 100 })) {
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
      event.type === "worker.action.completed"
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
    for (const incident of this.store.listIncidents()) {
      if (incident.status !== "monitoring" || incident.resolvedAt) continue;
      const sameTask = event.taskId && incident.taskId === event.taskId;
      const sameWorker = event.workerId && incident.workerId === event.workerId;
      if (!sameTask && !sameWorker) continue;
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
    let result;
    if (monitoring) {
      result = {
        incident: this.store.reopenIncident(
          monitoring.id,
          event.message || monitoring.error,
        ),
        created: false,
      };
    } else {
      result = this.store.createIncident({
        fingerprint: incidentFingerprint(event),
        severity: event.level === "warning" ? "warning" : "error",
        sourceEventId: event.id,
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
    }
    const { incident } = result;
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
    if (
      this.config.opsAutoHandle &&
      incident.attemptCount < this.config.opsMaxAttempts &&
      !["queued", "diagnosing", "acting"].includes(incident.status)
    ) {
      this.queueIncident(incident);
    }
  }

  queueIncident(incident, followup = null) {
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
    this.store.appendOpsTurn({
      message,
      trigger: followup ? "followup" : "incident",
      incidentId: incident.id,
      authorName: "Relay Auto Recovery",
    });
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
        this.activeTurns.set(turn.threadId, turn.id);
        void this.runTurn(turn);
      }
    } finally {
      this.pumping = false;
    }
  }

  async runTurn(turn) {
    try {
      await this.execute(turn);
    } finally {
      this.activeTurns.delete(turn.threadId);
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
      workers: snapshot.workers,
      recentTasks: snapshot.tasks.slice(0, 30),
      recentEvents: snapshot.events.slice(-100),
      openIncidents: snapshot.ops.incidents.filter((item) => !item.resolvedAt),
      recentLogs: recentLogExcerpts(this.config.logDirectory),
    };
  }

  buildPrompt(turn) {
    const context = this.buildContext(turn);
    return [
      "You are the persistent Relay system operations Codex.",
      "Your job is to diagnose any Relay, Hyper-V worker, Unity task, Git delivery, web, Guardian, or Relay-code incident.",
      "You have broad authority for reversible operations. Never delete files, data, logs, tasks, projects, workers, branches, tags, VMs, checkpoints, or worktrees.",
      ...actionPolicyPrompt(turn),
      "For an attention worker with a preserved failed task, prefer task.continue with precise recovery instructions so the same Codex thread and workspace are resumed without reset.",
      "Use worker.release only when delivery is already durable. Use worker.restart for infrastructure faults, not to discard uncommitted task work.",
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

  async execute(turn) {
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
      (action.type.startsWith("worker.") ? incident?.workerId : null);
    const actorName = "Relay Ops Codex";
    switch (action.type) {
      case "task.continue": {
        if (!targetId)
          throw new HttpError(
            400,
            "OPS_TARGET_MISSING",
            "Task target is required",
          );
        const queued = this.store.appendTurn(targetId, {
          message:
            action.message ||
            `Recover the preserved task after this failure: ${incident?.error || diagnosis.diagnosis}`,
          userName: actorName,
        });
        this.scheduler.notifyQueueChanged();
        return { pending: true, turnId: queued.id };
      }
      case "task.retry": {
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
