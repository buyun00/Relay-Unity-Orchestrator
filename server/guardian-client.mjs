import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class GuardianClient {
  constructor(
    config,
    { onEvent = null, fetcher = fetch, processStarter = spawn } = {},
  ) {
    this.config = config;
    this.onEvent = onEvent;
    this.fetcher = fetcher;
    this.processStarter = processStarter;
    this.timer = null;
    this.failures = 0;
    this.lastSeenAt = null;
    this.lastStartAt = 0;
    this.starting = false;
  }

  baseUrl() {
    return `http://127.0.0.1:${this.config.guardianPort}`;
  }

  status() {
    return {
      enabled: Boolean(this.config.guardianEnabled),
      reachable: this.failures === 0 && Boolean(this.lastSeenAt),
      failures: this.failures,
      lastSeenAt: this.lastSeenAt,
      port: this.config.guardianPort,
    };
  }

  start() {
    if (!this.config.guardianEnabled || this.timer) return;
    void this.check();
    this.timer = setInterval(
      () => void this.check(),
      this.config.guardianIntervalMs,
    );
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check() {
    const previousFailures = this.failures;
    try {
      const response = await this.fetcher(`${this.baseUrl()}/api/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error(`Guardian health ${response.status}`);
      this.lastSeenAt = new Date().toISOString();
      this.failures = 0;
      if (previousFailures >= this.config.guardianFailureThreshold) {
        this.onEvent?.({
          type: "guardian.health.recovered",
          phase: "guardian",
          message: "Relay Guardian is reachable again",
        });
      }
    } catch {
      this.failures += 1;
      if (this.failures === this.config.guardianFailureThreshold) {
        this.onEvent?.({
          type: "guardian.health.failed",
          phase: "guardian",
          level: "error",
          message: "Relay Guardian failed consecutive health checks",
          data: { failures: this.failures },
        });
      }
      if (this.failures >= this.config.guardianFailureThreshold) {
        await this.startGuardian();
      }
    }
  }

  async startGuardian() {
    if (this.starting) return;
    if (Date.now() - this.lastStartAt < this.config.guardianRestartCooldownMs)
      return;
    this.starting = true;
    this.lastStartAt = Date.now();
    try {
      this.onEvent?.({
        type: "guardian.restart.started",
        phase: "guardian",
        message: "Relay is starting the independent Guardian process",
      });
      fs.mkdirSync(this.config.logDirectory, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
      const stdout = fs.openSync(
        path.join(this.config.logDirectory, `guardian-${stamp}.stdout.log`),
        "a",
      );
      const stderr = fs.openSync(
        path.join(this.config.logDirectory, `guardian-${stamp}.stderr.log`),
        "a",
      );
      const child = this.processStarter(
        process.execPath,
        ["--env-file-if-exists=.env.local", "server/guardian.mjs"],
        {
          cwd: this.config.projectRoot,
          env: process.env,
          detached: true,
          windowsHide: true,
          stdio: ["ignore", stdout, stderr],
        },
      );
      child.unref();
      fs.closeSync(stdout);
      fs.closeSync(stderr);
      await wait(750);
      this.onEvent?.({
        type: "guardian.restart.requested",
        phase: "guardian",
        message: "Independent Guardian process was launched",
        data: { processId: child.pid },
      });
    } catch (error) {
      this.onEvent?.({
        type: "guardian.restart.failed",
        phase: "guardian",
        level: "error",
        message: `Relay could not start Guardian: ${error.message}`,
      });
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async request(pathname, body = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.fetcher(`${this.baseUrl()}${pathname}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(
            `Guardian request failed (${response.status}): ${text}`,
          );
        }
        return response.json();
      } catch (error) {
        if (attempt > 0) throw error;
        await this.startGuardian();
        await wait(1_000);
      }
    }
    return null;
  }

  requestRelayRestart(body) {
    return this.request("/api/actions/restart-relay", body);
  }

  requestWebRestart(body) {
    return this.request("/api/actions/restart-web", body);
  }

  requestGuardianRestart(body) {
    return this.request("/api/actions/restart-guardian", body);
  }

  requestDeploymentRestart(body) {
    return this.request("/api/actions/deployment-restart", body);
  }
}
