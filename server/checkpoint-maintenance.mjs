import fs from "node:fs";
import path from "node:path";

function uniqueHours(hours) {
  return [...new Set((hours || []).map(Number))]
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)
    .sort((left, right) => left - right);
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return {
    date: `${value.year}-${value.month}-${value.day}`,
    hour: Number(value.hour),
    minute: Number(value.minute),
    second: Number(value.second),
  };
}

function scheduledSlot(date, timeZone) {
  const local = localParts(date, timeZone);
  return `${local.date}T${String(local.hour).padStart(2, "0")}`;
}

function nextScheduledAttempt(now, timeZone, hours, state) {
  const minuteBase = new Date(now);
  minuteBase.setUTCSeconds(0, 0);
  for (let offset = 1; offset <= 48 * 60; offset += 1) {
    const candidate = new Date(minuteBase.getTime() + offset * 60_000);
    const local = localParts(candidate, timeZone);
    if (local.minute !== 0 || !hours.includes(local.hour)) continue;
    const slot = scheduledSlot(candidate, timeZone);
    if (state.successDate === local.date || state.attemptedSlots.includes(slot))
      continue;
    return {
      at: candidate.toISOString(),
      local: `${local.date} ${String(local.hour).padStart(2, "0")}:00`,
    };
  }
  return null;
}

function readState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      attemptedSlots: Array.isArray(parsed.attemptedSlots)
        ? parsed.attemptedSlots.map(String).slice(-32)
        : [],
      successDate: parsed.successDate || null,
      lastAttemptAt: parsed.lastAttemptAt || null,
      lastSuccessAt: parsed.lastSuccessAt || null,
      lastFailureAt: parsed.lastFailureAt || null,
      lastError: parsed.lastError || null,
      lastResults: Array.isArray(parsed.lastResults) ? parsed.lastResults : [],
    };
  } catch {
    return {
      attemptedSlots: [],
      successDate: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      lastResults: [],
    };
  }
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, statePath);
}

function errorRecord(error, worker = null) {
  const attention = error?.details?.checkpointFailure || null;
  return {
    workerId: worker?.id || null,
    workerName: worker?.name || null,
    ok: false,
    code: error?.code || "CHECKPOINT_MAINTENANCE_FAILED",
    error: error?.message || String(error),
    ...(attention ? { attention } : {}),
  };
}

function workerIsReady(worker) {
  return (
    worker?.enabled &&
    worker.status === "ready" &&
    !worker.currentTurnId &&
    worker.health?.vm === "healthy" &&
    worker.health?.heartbeat === "healthy" &&
    worker.health?.smb === "healthy" &&
    worker.health?.unity === "healthy"
  );
}

function unresolvedCheckpointIncident(store, worker) {
  if (typeof store?.listIncidents !== "function" || !worker?.id) return null;
  return (
    store
      .listIncidents({ limit: 500 })
      .find(
        (incident) =>
          incident.workerId === worker.id &&
          !incident.resolvedAt &&
          incident.context?.eventType === "checkpoint.maintenance.failed",
      ) || null
  );
}

export class CheckpointMaintenance {
  constructor(
    { config, store, scheduler, adapter },
    {
      now = () => new Date(),
      setIntervalFn = setInterval,
      clearIntervalFn = clearInterval,
    } = {},
  ) {
    this.config = config;
    this.store = store;
    this.scheduler = scheduler;
    this.adapter = adapter;
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.hours = uniqueHours(config.checkpointMaintenanceHours || [5, 6, 7]);
    this.timeZone = config.checkpointMaintenanceTimeZone || "Asia/Shanghai";
    this.statePath =
      config.checkpointMaintenanceStatePath ||
      path.join(config.dataDirectory, "checkpoint-maintenance.json");
    this.state = readState(this.statePath);
    this.timer = null;
    this.runPromise = null;
  }

  status() {
    const next = nextScheduledAttempt(
      this.now(),
      this.timeZone,
      this.hours,
      this.state,
    );
    const taskWorkload = this.store.getTaskWorkload?.() || null;
    return {
      enabled: Boolean(
        this.config.checkpointMaintenanceEnabled &&
        this.config.checkpointsEnabled,
      ),
      configured: Boolean(this.config.checkpointMaintenanceEnabled),
      running: Boolean(this.runPromise),
      hours: this.hours,
      timeZone: this.timeZone,
      retentionCount: Number(this.config.checkpointRetentionCount || 2),
      nextAttemptAt: next?.at || null,
      nextAttemptLocal: next?.local || null,
      lastAttemptAt: this.state.lastAttemptAt,
      lastSuccessAt: this.state.lastSuccessAt,
      lastFailureAt: this.state.lastFailureAt,
      lastError: this.state.lastError,
      lastResults: this.state.lastResults,
      taskGate: taskWorkload
        ? { idle: taskWorkload.totalTurns === 0, ...taskWorkload }
        : null,
    };
  }

  start() {
    if (
      this.timer ||
      !this.config.checkpointMaintenanceEnabled ||
      !this.config.checkpointsEnabled
    )
      return;
    const intervalMs = Math.max(
      10_000,
      Number(this.config.checkpointMaintenanceScanIntervalMs || 30_000),
    );
    this.timer = this.setIntervalFn(() => void this.tick(), intervalMs);
    this.timer?.unref?.();
    queueMicrotask(() => void this.tick());
  }

  stop() {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  waitForIdle(timeoutMs = 15_000) {
    if (!this.runPromise) return Promise.resolve(true);
    return Promise.race([
      this.runPromise.then(
        () => true,
        () => true,
      ),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  tick() {
    if (
      !this.config.checkpointMaintenanceEnabled ||
      !this.config.checkpointsEnabled ||
      this.runPromise
    )
      return this.runPromise;
    const current = this.now();
    const local = localParts(current, this.timeZone);
    if (!this.hours.includes(local.hour)) return null;
    if (this.state.successDate === local.date) return null;
    const slot = scheduledSlot(current, this.timeZone);
    if (this.state.attemptedSlots.includes(slot)) return null;
    return this.runNow({
      slot,
      reason: `scheduled ${slot}:00 ${this.timeZone}`,
    });
  }

  runNow({
    workerId = null,
    slot = null,
    reason = "operator request",
    useCurrentRestoredState = false,
  } = {}) {
    if (this.runPromise) return this.runPromise;
    const startedAt = this.now();
    const local = localParts(startedAt, this.timeZone);
    const attemptSlot = slot || `manual:${startedAt.toISOString()}`;
    this.state.attemptedSlots = [
      ...this.state.attemptedSlots.filter((item) => item !== attemptSlot),
      attemptSlot,
    ].slice(-32);
    this.state.lastAttemptAt = startedAt.toISOString();
    writeState(this.statePath, this.state);
    this.runPromise = this.execute({
      workerId,
      localDate: local.date,
      attemptSlot,
      reason,
      useCurrentRestoredState,
    }).finally(() => {
      this.runPromise = null;
    });
    return this.runPromise;
  }

  async execute({
    workerId,
    localDate,
    attemptSlot,
    reason,
    useCurrentRestoredState,
  }) {
    const workers = this.store
      .listWorkers()
      .filter(
        (worker) => worker.enabled && (!workerId || worker.id === workerId),
      );
    if (workerId && !workers.length) {
      throw Object.assign(
        new Error("Checkpoint maintenance worker was not found"),
        {
          code: "WORKER_NOT_FOUND",
        },
      );
    }
    const results = [];
    for (const listedWorker of workers) {
      let worker = this.store.getWorker(listedWorker.id);
      const project = worker?.projectId
        ? this.store.getProject(worker.projectId)
        : null;
      if (!project?.enabled) continue;
      const blockingIncident = unresolvedCheckpointIncident(this.store, worker);
      if (blockingIncident) {
        results.push({
          workerId: worker.id,
          workerName: worker.name,
          ok: false,
          deferred: true,
          code: "CHECKPOINT_MAINTENANCE_INCIDENT_OPEN",
          incidentId: blockingIncident.id,
          error: `Checkpoint maintenance remains closed for ${worker.name} while incident ${blockingIncident.id} is unresolved; its workspace was not touched`,
        });
        continue;
      }
      if (!workerIsReady(worker)) {
        results.push({
          workerId: worker.id,
          workerName: worker.name,
          ok: false,
          deferred: true,
          code: "CHECKPOINT_MAINTENANCE_WORKER_NOT_IDLE",
          error: `Worker ${worker.name} is ${worker.status} or not fully healthy; its workspace was not touched`,
        });
        continue;
      }

      if (
        typeof this.store.reserveWorkerForCheckpointMaintenance !== "function"
      ) {
        throw Object.assign(
          new Error(
            "Checkpoint maintenance task-queue guard is unavailable; refusing to touch the worker",
          ),
          { code: "CHECKPOINT_MAINTENANCE_QUEUE_GUARD_UNAVAILABLE" },
        );
      }
      const reservation = this.store.reserveWorkerForCheckpointMaintenance(
        worker.id,
      );
      if (!reservation.reserved) {
        const workload = reservation.workload || {
          queuedTurns: 0,
          executingTurns: 0,
          totalTurns: 0,
        };
        const queueBusy =
          reservation.code === "CHECKPOINT_MAINTENANCE_TASK_QUEUE_NOT_EMPTY";
        results.push({
          workerId: worker.id,
          workerName: worker.name,
          ok: false,
          deferred: true,
          code: reservation.code || "CHECKPOINT_MAINTENANCE_WORKER_NOT_IDLE",
          queuedTurns: workload.queuedTurns,
          executingTurns: workload.executingTurns,
          error: queueBusy
            ? `Relay still has ${workload.executingTurns} executing and ${workload.queuedTurns} queued task turn(s); checkpoint maintenance did not touch ${worker.name}`
            : `Worker ${worker.name} stopped being idle before checkpoint maintenance could reserve it`,
        });
        this.scheduler.notifyQueueChanged?.();
        continue;
      }
      worker = reservation.worker || this.store.getWorker(worker.id);
      this.store.emit({
        workerId: worker.id,
        actorName: "Relay Checkpoint Maintenance",
        type: "checkpoint.maintenance.started",
        phase: "checkpoint-maintenance",
        message: `Refreshing ${worker.checkpointName || "PROJECT_READY"} for ${worker.name}`,
        data: { attemptSlot, reason },
      });

      try {
        const result = await this.adapter.refreshWorkerCheckpoint(
          worker,
          project,
          {
            retentionCount: Number(this.config.checkpointRetentionCount || 2),
            useCurrentRestoredState,
          },
        );
        const health = await this.adapter.probeWorker(worker);
        this.store.updateWorkerHealth(worker.id, health);
        if (!health.ready) {
          throw Object.assign(
            new Error(
              `New checkpoint passed its canary, but the final worker probe failed: ${health.error || "worker not ready"}`,
            ),
            { code: "CHECKPOINT_MAINTENANCE_FINAL_PROBE_FAILED" },
          );
        }
        this.store.setWorkerState(worker.id, "ready", {
          currentTurnId: null,
          error: null,
        });
        const record = {
          workerId: worker.id,
          workerName: worker.name,
          ok: true,
          oldHead: result.oldHead || null,
          newHead: result.newHead || null,
          checkpointName: result.checkpointName || worker.checkpointName,
          checkpointId: result.checkpointId || null,
          checkpoints: result.checkpoints || [],
        };
        results.push(record);
        this.store.emit({
          workerId: worker.id,
          actorName: "Relay Checkpoint Maintenance",
          type: "checkpoint.maintenance.completed",
          phase: "checkpoint-maintenance",
          message: `Created and canary-verified a fresh ${record.checkpointName} for ${worker.name}`,
          data: record,
        });
      } catch (error) {
        let health = null;
        try {
          health = await this.adapter.probeWorker(worker);
          this.store.updateWorkerHealth(worker.id, health);
        } catch {
          health = null;
        }
        this.store.setWorkerState(
          worker.id,
          health?.ready ? "ready" : "attention",
          {
            currentTurnId: null,
            error: health?.ready ? null : error?.message || String(error),
          },
        );
        const record = errorRecord(error, worker);
        results.push(record);
        this.store.emit({
          workerId: worker.id,
          actorName: "Relay Checkpoint Maintenance",
          type: "checkpoint.maintenance.failed",
          phase: "checkpoint-maintenance",
          level: "error",
          message: `Checkpoint refresh failed for ${worker.name}: ${record.error}`,
          data: { ...record, attemptSlot, reason },
        });
      } finally {
        this.scheduler.notifyQueueChanged?.();
      }
    }

    const failures = results.filter((result) => !result.ok);
    const hardFailures = failures.filter((result) => !result.deferred);
    const windowFailures = failures.filter(
      (result) => result.code !== "CHECKPOINT_MAINTENANCE_INCIDENT_OPEN",
    );
    const finalScheduledHour = this.hours.at(-1);
    const slotHour = /^\d{4}-\d{2}-\d{2}T(\d{2})$/u.exec(attemptSlot);
    const windowExhausted =
      windowFailures.length > 0 &&
      Number(slotHour?.[1]) === finalScheduledHour;
    const now = this.now().toISOString();
    this.state.lastResults = results;
    if (!failures.length && results.length > 0) {
      this.state.successDate = localDate;
      this.state.lastSuccessAt = now;
      this.state.lastError = null;
    } else {
      this.state.lastFailureAt = now;
      this.state.lastError = failures.length
        ? failures.map((result) => result.error).join("; ")
        : "No enabled project worker was eligible for checkpoint maintenance";
    }
    writeState(this.statePath, this.state);

    if (windowExhausted && hardFailures.length === 0) {
      const first = failures[0];
      this.store.emit({
        workerId: first.workerId,
        actorName: "Relay Checkpoint Maintenance",
        type: "checkpoint.maintenance.failed",
        phase: "checkpoint-maintenance",
        level: "error",
        message: `The 05/06/07 checkpoint refresh window ended while Relay still had work or no worker was safely idle: ${first.error}`,
        data: {
          code: "CHECKPOINT_MAINTENANCE_WINDOW_EXHAUSTED",
          attemptSlot,
          results,
        },
      });
    } else if (failures.length && hardFailures.length === 0) {
      this.store.emit({
        actorName: "Relay Checkpoint Maintenance",
        type: "checkpoint.maintenance.deferred",
        phase: "checkpoint-maintenance",
        level: "warning",
        message:
          "Checkpoint refresh was deferred because Relay still had active or queued work, or no worker was safely idle",
        data: { attemptSlot, results },
      });
    }

    return {
      ok: failures.length === 0 && results.length > 0,
      attemptSlot,
      results,
    };
  }
}

export const checkpointMaintenanceInternals = {
  localParts,
  nextScheduledAttempt,
  scheduledSlot,
  uniqueHours,
  workerIsReady,
};
