export class BuildStatusMonitor {
  constructor({
    store,
    client,
    pollIntervalMs = 5_000,
    failedPollIntervalMs = 30_000,
    retryScheduleMs = [5_000, 15_000, 30_000, 60_000],
    retryMaxMs = 300_000,
    batchSize = 8,
    clock = () => Date.now(),
    random = Math.random,
  }) {
    this.store = store;
    this.client = client;
    this.pollIntervalMs = Math.max(100, Number(pollIntervalMs) || 5_000);
    this.failedPollIntervalMs = Math.max(
      this.pollIntervalMs,
      Number(failedPollIntervalMs) || 30_000,
    );
    this.retryScheduleMs =
      Array.isArray(retryScheduleMs) && retryScheduleMs.length
        ? retryScheduleMs.map((value) => Math.max(1, Number(value) || 1))
        : [5_000];
    this.retryMaxMs = Math.max(1, Number(retryMaxMs) || 300_000);
    this.batchSize = Math.max(1, Math.min(32, Number(batchSize) || 8));
    this.clock = clock;
    this.random = random;
    this.running = false;
    this.pumping = false;
    this.timer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.pump(), this.pollIntervalMs);
    this.timer.unref?.();
    void this.pump();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  notify() {
    if (this.running) void this.pump();
  }

  waitForIdle(timeoutMs = 15_000) {
    if (!this.pumping) return Promise.resolve(true);
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const timer = setInterval(() => {
        if (!this.pumping || Date.now() >= deadline) {
          clearInterval(timer);
          resolve(!this.pumping);
        }
      }, 25);
      timer.unref?.();
    });
  }

  retryDelay(dispatch, error) {
    const scheduleIndex = Math.min(
      Math.max(0, dispatch.statusCheckAttemptCount),
      this.retryScheduleMs.length - 1,
    );
    const scheduled = Math.min(
      this.retryMaxMs,
      this.retryScheduleMs[scheduleIndex],
    );
    const jittered = Math.max(
      1,
      Math.round(scheduled * (0.8 + this.random() * 0.4)),
    );
    return Math.max(jittered, Number(error?.retryAfterMs) || 0);
  }

  async check(dispatch) {
    try {
      const job = await this.client.getJob(dispatch);
      const nextPollIntervalMs =
        String(job?.status || "").trim().toLowerCase() === "failed"
          ? this.failedPollIntervalMs
          : this.pollIntervalMs;
      this.store.updateBuildStatus(dispatch.id, job, {
        nextCheckAt: new Date(
          this.clock() + nextPollIntervalMs,
        ).toISOString(),
      });
    } catch (error) {
      const delayMs = this.retryDelay(dispatch, error);
      this.store.recordBuildStatusCheckFailure(dispatch.id, error, {
        nextCheckAt: new Date(this.clock() + delayMs).toISOString(),
      });
    }
  }

  async pump() {
    if (!this.running || this.pumping) return;
    this.pumping = true;
    try {
      while (this.running) {
        const dispatches = this.store.listBuildDispatchesForStatusCheck(
          new Date(this.clock()).toISOString(),
          this.batchSize,
        );
        if (!dispatches.length) break;
        await Promise.all(dispatches.map((dispatch) => this.check(dispatch)));
      }
    } finally {
      this.pumping = false;
    }
  }
}
