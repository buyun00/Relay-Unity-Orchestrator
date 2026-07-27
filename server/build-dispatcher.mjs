export class BuildDispatcher {
  constructor({
    store,
    client,
    pollIntervalMs = 1_000,
    retryScheduleMs = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000],
    retryMaxMs = 300_000,
    clock = () => Date.now(),
    random = Math.random,
  }) {
    this.store = store;
    this.client = client;
    this.pollIntervalMs = Math.max(10, Number(pollIntervalMs) || 1_000);
    this.retryScheduleMs =
      Array.isArray(retryScheduleMs) && retryScheduleMs.length
        ? retryScheduleMs.map((value) => Math.max(1, Number(value) || 1))
        : [1_000];
    this.retryMaxMs = Math.max(1, Number(retryMaxMs) || 300_000);
    this.clock = clock;
    this.random = random;
    this.running = false;
    this.pumping = false;
    this.timer = null;
    this.current = null;
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
      Math.max(0, dispatch.attemptCount - 1),
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
    return Math.max(jittered, Number(error.retryAfterMs) || 0);
  }

  async pump() {
    if (!this.running || this.pumping) return;
    this.pumping = true;
    try {
      while (this.running) {
        const dispatch = this.store.claimNextBuildDispatch(
          new Date(this.clock()).toISOString(),
        );
        if (!dispatch) break;
        this.current = dispatch;
        try {
          const accepted = await this.client.submit(dispatch);
          this.store.acceptBuildDispatch(dispatch.id, accepted);
        } catch (error) {
          if (error?.retryable) {
            const delayMs = this.retryDelay(dispatch, error);
            this.store.retryBuildDispatch(dispatch.id, error, {
              nextAttemptAt: new Date(this.clock() + delayMs).toISOString(),
              delayMs,
            });
          } else {
            this.store.failBuildDispatch(dispatch.id, error);
          }
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}
