import { id, shortSha, sleep } from "../../server/util.mjs";

function fakeFailure(message, phase) {
  return String(message || "")
    .toLowerCase()
    .includes(`[fake:fail=${phase}]`);
}

export class FakeAdapter {
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
      adapter: "test",
    };
  }

  async prepare(context, { signal, onProgress }) {
    onProgress?.("restore", "Restoring PROJECT_READY checkpoint");
    await sleep(this.config.phaseMs, signal);
    if (fakeFailure(context.turn.userMessage, "prepare")) {
      throw Object.assign(new Error("Fake checkpoint restore failed"), {
        code: "CHECKPOINT_RESTORE_FAILED",
      });
    }
    onProgress?.(
      "workspace",
      `Checking out ${context.task.branchName} inside the guest`,
    );
    await sleep(this.config.phaseMs, signal);
    onProgress?.("unity", "Unity and Unity Skill are ready");
    await sleep(this.config.phaseMs, signal);
    return {
      workspace: context.worker.sharePath,
      resumed: Boolean(context.task.codexThreadId),
    };
  }

  async resumePreserved(context, { signal, onProgress }) {
    onProgress?.(
      "workspace",
      `Verifying preserved ${context.task.branchName} workspace`,
    );
    await sleep(this.config.phaseMs, signal);
    onProgress?.("unity", "Preserved workspace and Unity are ready");
    await sleep(this.config.phaseMs, signal);
    return {
      workspace: context.worker.sharePath,
      resumed: true,
      preserved: true,
    };
  }

  async runCodex(context, { signal, onEvent }) {
    const steps = [
      { type: "turn.started", message: "Codex accepted the turn" },
      { type: "item.started", message: "Inspecting project and Unity assets" },
      {
        type: "item.completed",
        item: {
          id: "agent-message-1",
          type: "agent_message",
          text: "I found the relevant Unity assets and am applying the requested changes.",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "agent-message-2",
          type: "agent_message",
          text: "The changes are in place; I am running the final validation now.",
        },
      },
    ];
    for (const event of steps) {
      await sleep(this.config.phaseMs, signal);
      onEvent?.(event);
    }
    if (fakeFailure(context.turn.userMessage, "codex")) {
      throw Object.assign(new Error("Fake Codex execution failed"), {
        code: "CODEX_EXEC_FAILED",
      });
    }
    return {
      threadId: context.task.codexThreadId || id("test-thread-"),
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
    await sleep(this.config.phaseMs, signal);
    if (fakeFailure(context.turn.userMessage, "unity-save")) {
      throw Object.assign(new Error("Fake Unity save failed"), {
        code: "UNITY_SAVE_FAILED",
      });
    }
    onProgress?.("commit", "Committing changes inside the guest");
    await sleep(this.config.phaseMs, signal);
    onProgress?.(
      "push",
      `Pushing ${context.task.branchName} and verifying remote SHA`,
    );
    await sleep(this.config.phaseMs, signal);
    if (fakeFailure(context.turn.userMessage, "push")) {
      throw Object.assign(
        new Error("Fake remote push failed; workspace preserved"),
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
    await sleep(this.config.phaseMs, signal);
    if (fakeFailure(context.turn.userMessage, "release")) {
      throw Object.assign(new Error("Fake worker release failed"), {
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
    await sleep(Math.min(500, this.config.phaseMs));
    return { action, ...(await this.probeWorker(worker)) };
  }
}
