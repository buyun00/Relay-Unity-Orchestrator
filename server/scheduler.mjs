import { HttpError } from "./util.mjs";

function errorWithCode(error, fallback) {
  if (error?.code) return error;
  return Object.assign(
    error instanceof Error ? error : new Error(String(error)),
    { code: fallback },
  );
}

function codexMessage(event) {
  if (typeof event?.message === "string" && event.message.trim())
    return event.message.trim();
  if (typeof event?.item?.text === "string" && event.item.text.trim())
    return event.item.text.trim();
  if (typeof event?.item?.message === "string" && event.item.message.trim())
    return event.item.message.trim();
  if (event?.type) return `Codex: ${event.type}`;
  return "Codex emitted an event";
}

function codexAgentMessage(event) {
  if (event?.type !== "item.completed") return null;
  if (event?.item?.type !== "agent_message") return null;
  const text =
    typeof event.item.text === "string"
      ? event.item.text.trim()
      : typeof event.item.message === "string"
        ? event.item.message.trim()
        : "";
  if (!text) return null;
  return {
    itemId: event.item.id || null,
    text,
  };
}

function threadIdFromEvent(event) {
  if (event?.type !== "thread.started") return null;
  return event.thread_id || event.threadId || event.thread?.id || null;
}

export class Scheduler {
  constructor({ config, store, adapter }) {
    this.config = config;
    this.store = store;
    this.adapter = adapter;
    this.running = false;
    this.paused = false;
    this.pumping = false;
    this.probing = false;
    this.controllers = new Map();
    this.executions = new Set();
    this.timers = [];
  }

  async start({ paused = false } = {}) {
    if (this.running) return;
    this.running = true;
    this.paused = Boolean(paused);
    this.timers.push(
      setInterval(() => this.pump(), this.config.schedulerIntervalMs),
    );
    this.timers.push(
      setInterval(() => this.probeAll(), this.config.healthIntervalMs),
    );
    this.store.emit({
      type: "scheduler.started",
      phase: "system",
      message: `Scheduler started with ${this.config.adapter} adapter`,
      data: { adapter: this.config.adapter },
    });
    await this.probeAll();
    await this.pump();
  }

  stop() {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const controller of this.controllers.values()) {
      controller.abort(
        Object.assign(new Error("Scheduler stopped"), {
          code: "SCHEDULER_STOPPED",
        }),
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

  setPaused(paused, actorName = null) {
    this.paused = Boolean(paused);
    this.store.emit({
      actorName,
      type: paused ? "scheduler.paused" : "scheduler.resumed",
      level: paused ? "warning" : "info",
      phase: "system",
      message: paused
        ? "Scheduler paused; queued turns are preserved"
        : "Scheduler resumed",
    });
    if (!paused) void this.pump();
    return this.status();
  }

  status() {
    return {
      running: this.running,
      paused: this.paused,
      activeTurns: this.controllers.size,
    };
  }

  runtimeStatus() {
    return this.adapter.runtimeStatus?.() || null;
  }

  inspectRuntime(options) {
    if (!this.adapter.inspectRuntime) return Promise.resolve(null);
    return this.adapter.inspectRuntime(options);
  }

  notifyQueueChanged() {
    void this.pump();
  }

  async pump() {
    if (!this.running || this.paused || this.pumping) return;
    this.pumping = true;
    try {
      while (this.running && !this.paused) {
        const context = this.store.claimNextTurn();
        if (!context) {
          const stoppedWorker =
            this.store.reserveStoppedWorkerForQueuedTurn?.();
          if (!stoppedWorker) break;
          try {
            await this.controlWorker(stoppedWorker.id, "start");
          } catch {
            // controlWorker already records the failure and moves the worker
            // to attention. Continue so another compatible stopped worker can
            // be tried without leaving the queue silently blocked.
          }
          continue;
        }
        const controller = new AbortController();
        this.controllers.set(context.turn.id, controller);
        const execution = this.execute(context, controller);
        this.executions.add(execution);
        void execution.finally(() => {
          this.executions.delete(execution);
          this.controllers.delete(context.turn.id);
          void this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  emitProgress(context, phase, message, level = "info", data = null) {
    this.store.emit({
      taskId: context.task.id,
      turnId: context.turn.id,
      workerId: context.worker.id,
      type: `turn.${phase}`,
      phase,
      level,
      message,
      data,
    });
  }

  async execute(context, controller) {
    const signal = controller.signal;
    try {
      if (context.resumePreservedWorkspace) {
        this.emitProgress(
          context,
          "resume",
          `Continuing preserved workspace on ${context.worker.name} without checkpoint restore or Git reset`,
        );
        await this.adapter.resumePreserved?.(context, {
          signal,
          onProgress: (phase, message) =>
            this.emitProgress(context, phase, message),
        });
      } else {
        this.emitProgress(
          context,
          "prepare",
          `Worker ${context.worker.name} reserved for turn ${context.turn.sequence}`,
        );
        await this.adapter.prepare(context, {
          signal,
          onProgress: (phase, message) =>
            this.emitProgress(context, phase, message),
        });
      }
      if (this.store.getTurn(context.turn.id)?.status === "cancelled") return;

      this.store.setTurnPhase(context.turn.id, "running");
      this.emitProgress(
        context,
        "codex",
        context.task.codexThreadId
          ? `Resuming Codex conversation ${context.task.codexThreadId}`
          : "Starting a persistent Codex conversation",
      );
      const codexResult = await this.adapter.runCodex(context, {
        signal,
        onEvent: (event) => {
          const threadId = threadIdFromEvent(event);
          if (threadId) this.store.setTaskThread(context.task.id, threadId);
          const type = event?.type || "codex.event";
          const agentMessage = codexAgentMessage(event);
          if (agentMessage) {
            this.store.emit({
              taskId: context.task.id,
              turnId: context.turn.id,
              workerId: context.worker.id,
              type: "codex.agent_message",
              phase: "codex",
              level: "info",
              message: agentMessage.text.slice(0, 100_000),
              data: {
                eventType: type,
                itemId: agentMessage.itemId,
                itemType: "agent_message",
              },
            });
            return;
          }
          const noisy = ["item.updated", "turn.updated"].includes(type);
          if (!noisy) {
            this.store.emit({
              taskId: context.task.id,
              turnId: context.turn.id,
              workerId: context.worker.id,
              type: `codex.${type}`,
              phase: "codex",
              level: type === "codex.stderr" ? "warning" : "info",
              message: codexMessage(event).slice(0, 2_000),
              data: { eventType: type },
            });
          }
        },
      });
      this.store.setTaskThread(context.task.id, codexResult.threadId);
      if (this.store.getTurn(context.turn.id)?.status === "cancelled") return;

      this.store.setTurnPhase(context.turn.id, "saving");
      this.emitProgress(
        context,
        "delivery",
        "Codex completed; beginning durable delivery",
      );
      const delivery = await this.adapter.finalize(context, {
        signal,
        onProgress: (phase, message) =>
          this.emitProgress(context, phase, message),
      });
      this.store.completeTurn(context.turn.id, {
        codexFinal: codexResult.final,
        commitSha: delivery.commitSha,
      });
      this.emitProgress(
        context,
        "delivered",
        "Remote branch verified; conversation and commit were saved",
        "info",
        {
          branchName: context.task.branchName,
          commitSha: delivery.commitSha,
          threadId: codexResult.threadId,
        },
      );

      if (!context.task.autoRelease) {
        this.store.assignNextQueuedTurn(context.task.id, context.worker.id);
        this.store.setWorkerState(context.worker.id, "reserved", {
          currentTurnId: null,
          error: null,
        });
        this.emitProgress(
          context,
          "reserved",
          "Auto-release is disabled; worker remains reserved",
          "warning",
        );
        return;
      }

      try {
        await this.adapter.release(context, {
          signal,
          onProgress: (phase, message) =>
            this.emitProgress(context, phase, message),
        });
        this.store.releaseWorkerAfterSuccess(context.worker.id);
        this.emitProgress(
          context,
          "released",
          `Worker ${context.worker.name} returned to the ready pool`,
        );
      } catch (releaseError) {
        const error = errorWithCode(releaseError, "WORKER_RELEASE_FAILED");
        this.store.assignNextQueuedTurn(context.task.id, context.worker.id);
        this.store.setWorkerState(context.worker.id, "attention", {
          currentTurnId: null,
          error: error.message,
        });
        this.emitProgress(
          context,
          "release-failed",
          `Delivery succeeded, but worker release failed: ${error.message}`,
          "error",
          { code: error.code },
        );
      }
    } catch (caught) {
      const currentTurn = this.store.getTurn(context.turn.id);
      if (currentTurn?.status === "cancelled") {
        this.store.setWorkerState(context.worker.id, "attention", {
          currentTurnId: null,
          error:
            "Turn cancelled after execution began; inspect preserved workspace",
        });
        return;
      }
      const error = errorWithCode(caught, "TURN_EXECUTION_FAILED");
      this.store.failTurn(context.turn.id, error, { preserveWorker: true });
      this.emitProgress(
        context,
        "failed",
        `${error.message}. Worker workspace was preserved and was not reset.`,
        "error",
        { code: error.code },
      );
    }
  }

  cancelTask(taskId, actorName = null) {
    const result = this.store.cancelCurrentTurn(taskId, actorName);
    const controller = this.controllers.get(result.turn.id);
    controller?.abort(
      Object.assign(new Error("Cancelled by user"), {
        code: "CANCELLED_BY_USER",
      }),
    );
    this.notifyQueueChanged();
    return result.turn;
  }

  retryTask(taskId, actorName = null) {
    const turn = this.store.retryTask(taskId, actorName);
    this.notifyQueueChanged();
    return turn;
  }

  async probeAll() {
    if (this.probing) return;
    this.probing = true;
    try {
      const projects = new Map(
        this.store.listProjects().map((project) => [project.id, project]),
      );
      for (const worker of this.store.listWorkers()) {
        if (
          !worker.enabled ||
          worker.currentTurnId ||
          ["busy", "preparing", "reserved"].includes(worker.status)
        )
          continue;
        const health = await this.adapter.probeWorker({
          ...worker,
          project: projects.get(worker.projectId) || null,
        });
        const updated = this.store.updateWorkerHealth(worker.id, health);
        const wasUnhealthy =
          ["attention", "offline"].includes(worker.status) ||
          Object.values(worker.health || {}).includes("error");
        const isUnhealthy =
          health.ready === false ||
          health.vm === false ||
          health.heartbeat === false ||
          health.smb === false ||
          health.unity === false ||
          health.skill === false ||
          ["attention", "offline"].includes(updated?.status);
        if (
          isUnhealthy &&
          (!wasUnhealthy || (health.error && health.error !== worker.lastError))
        ) {
          this.store.emit({
            workerId: worker.id,
            type: "worker.unhealthy",
            phase: "health",
            level: "error",
            message:
              health.error ||
              `Worker ${worker.name} failed one or more health checks`,
            data: {
              status: updated?.status,
              health,
            },
          });
        }
      }
    } finally {
      this.probing = false;
    }
    void this.pump();
  }

  async controlWorker(
    workerId,
    action,
    { force = false, actorName = null } = {},
  ) {
    const allowed = [
      "start",
      "shutdown",
      "restart",
      "forceOff",
      "restore",
      "probe",
      "release",
    ];
    if (!allowed.includes(action))
      throw new HttpError(
        400,
        "INVALID_WORKER_ACTION",
        "Unsupported worker action",
      );
    let worker = this.store.getWorker(workerId);
    if (!worker)
      throw new HttpError(404, "WORKER_NOT_FOUND", "Worker not found");
    if (worker.currentTurnId && !force) {
      throw new HttpError(
        409,
        "WORKER_BUSY",
        "Worker has an active turn; pass force=true only after confirming data-loss risk",
      );
    }
    if (worker.currentTurnId && force) {
      const turn = this.store.getTurn(worker.currentTurnId);
      if (turn) this.cancelTask(turn.taskId, actorName);
      worker = this.store.getWorker(workerId);
    }

    if (action !== "probe")
      this.store.setWorkerState(workerId, "preparing", { error: null });
    this.store.emit({
      workerId,
      actorName,
      type: "worker.action.started",
      phase: "worker-control",
      message: `${action} requested for ${worker.name}`,
      data: { action },
    });
    try {
      const result = await this.adapter.controlWorker(worker, action);
      if (["shutdown", "forceOff"].includes(action)) {
        this.store.setWorkerState(workerId, "stopped", {
          currentTurnId: null,
          error: null,
        });
      } else if (["start", "restart", "restore", "release"].includes(action)) {
        this.store.setWorkerState(workerId, "ready", {
          currentTurnId: null,
          error: null,
        });
      }
      const health =
        action === "probe" ? result : await this.adapter.probeWorker(worker);
      const updated = this.store.updateWorkerHealth(workerId, health);
      this.store.emit({
        workerId,
        actorName,
        type: "worker.action.completed",
        phase: "worker-control",
        message: `${action} completed for ${worker.name}`,
        data: { action },
      });
      this.notifyQueueChanged();
      return updated;
    } catch (error) {
      this.store.setWorkerState(workerId, "attention", {
        currentTurnId: null,
        error: error.message,
      });
      this.store.emit({
        workerId,
        actorName,
        type: "worker.action.failed",
        phase: "worker-control",
        level: "error",
        message: `${action} failed for ${worker.name}: ${error.message}`,
        data: { action, code: error.code || "WORKER_ACTION_FAILED" },
      });
      throw error;
    }
  }
}
