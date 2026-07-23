import { id, shortSha, sleep } from "../util.mjs";

function mockFailure(message, phase) {
  return String(message || "")
    .toLowerCase()
    .includes(`[mock:fail=${phase}]`);
}

export class MockAdapter {
  constructor(config) {
    this.config = config;
    this.workerOverrides = new Map();
  }

  async probeWorker(worker) {
    const override = this.workerOverrides.get(worker.id);
    const running = override
      ? override !== "stopped"
      : worker.status !== "stopped";
    return {
      ready: running,
      vm: running,
      heartbeat: running,
      smb: running,
      unity: running,
      skill: running,
      adapter: "mock",
    };
  }

  async prepare(context, { signal, onProgress }) {
    onProgress?.("restore", "Restoring PROJECT_READY checkpoint");
    await sleep(this.config.mockPhaseMs, signal);
    if (mockFailure(context.turn.userMessage, "prepare")) {
      throw Object.assign(new Error("Mock checkpoint restore failed"), {
        code: "CHECKPOINT_RESTORE_FAILED",
      });
    }
    onProgress?.(
      "workspace",
      `Checking out ${context.task.branchName} inside the guest`,
    );
    await sleep(this.config.mockPhaseMs, signal);
    onProgress?.("unity", "Unity and Unity Skill are ready");
    await sleep(this.config.mockPhaseMs, signal);
    return {
      workspace: context.worker.sharePath,
      resumed: Boolean(context.task.codexThreadId),
    };
  }

  async runCodex(context, { signal, onEvent }) {
    const steps = [
      ["turn.started", "Codex accepted the turn"],
      ["item.started", "Inspecting project and Unity assets"],
      ["item.completed", "Applied requested changes"],
      ["item.completed", "Completed static validation"],
    ];
    for (const [type, message] of steps) {
      await sleep(this.config.mockPhaseMs, signal);
      onEvent?.({ type, message });
    }
    if (mockFailure(context.turn.userMessage, "codex")) {
      throw Object.assign(new Error("Mock Codex execution failed"), {
        code: "CODEX_EXEC_FAILED",
      });
    }
    return {
      threadId: context.task.codexThreadId || id("mock-thread-"),
      final: {
        status: "completed",
        summary: `Completed turn ${context.turn.sequence}: ${context.turn.userMessage.slice(0, 120)}`,
        changedFiles: [
          "Assets/AppAssets/Example/ExampleView.cs",
          "Assets/AppAssets/Example/Example.prefab",
        ],
        validation: [
          "Unity asset serialization completed",
          "Static validation passed",
        ],
        risks: [],
        question: null,
      },
      jsonlPath: null,
      finalPath: null,
    };
  }

  async finalize(context, { signal, onProgress }) {
    onProgress?.("unity-save", "Saving all Unity assets to disk");
    await sleep(this.config.mockPhaseMs, signal);
    if (mockFailure(context.turn.userMessage, "unity-save")) {
      throw Object.assign(new Error("Mock Unity save failed"), {
        code: "UNITY_SAVE_FAILED",
      });
    }
    onProgress?.("commit", "Committing changes inside the guest");
    await sleep(this.config.mockPhaseMs, signal);
    onProgress?.(
      "push",
      `Pushing ${context.task.branchName} and verifying remote SHA`,
    );
    await sleep(this.config.mockPhaseMs, signal);
    if (mockFailure(context.turn.userMessage, "push")) {
      throw Object.assign(
        new Error("Mock remote push failed; workspace preserved"),
        { code: "GIT_PUSH_FAILED" },
      );
    }
    return {
      commitSha: shortSha(
        `${context.task.id}:${context.turn.id}:${Date.now()}`,
      ),
      pushed: true,
      verified: true,
    };
  }

  async release(context, { signal, onProgress }) {
    onProgress?.("release", "Restoring clean PROJECT_READY state");
    await sleep(this.config.mockPhaseMs, signal);
    if (mockFailure(context.turn.userMessage, "release")) {
      throw Object.assign(new Error("Mock worker release failed"), {
        code: "WORKER_RELEASE_FAILED",
      });
    }
    return { ready: true };
  }

  async controlWorker(worker, action) {
    if (["shutdown", "forceOff"].includes(action))
      this.workerOverrides.set(worker.id, "stopped");
    else if (["start", "restart", "restore", "release"].includes(action))
      this.workerOverrides.set(worker.id, "running");
    else if (action !== "probe")
      throw Object.assign(new Error(`Unsupported worker action: ${action}`), {
        code: "ACTION_NOT_SUPPORTED",
      });
    await sleep(Math.min(500, this.config.mockPhaseMs));
    return { action, ...(await this.probeWorker(worker)) };
  }
}
