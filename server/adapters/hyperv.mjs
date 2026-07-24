import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRunner } from "../codex-runner.mjs";
import { runProcess } from "../process.mjs";
import { parseJson, resolveWorkerTemplate } from "../util.mjs";

const scriptsDirectory = fileURLToPath(
  new URL("../../scripts/hyperv/", import.meta.url),
);

function script(name) {
  return path.join(scriptsDirectory, name);
}

function required(value, label) {
  if (!value)
    throw Object.assign(
      new Error(`${label} is required for the Hyper-V adapter`),
      { code: "HYPERV_CONFIG_MISSING" },
    );
  return value;
}

export class HyperVAdapter {
  constructor(
    config,
    { processRunner = runProcess, codex = new CodexRunner(config) } = {},
  ) {
    this.config = config;
    this.processRunner = processRunner;
    this.codex = codex;
    this.runtime = null;
    this.runtimeCheckedAt = 0;
    this.runtimePromise = null;
  }

  async powershell(
    scriptName,
    namedArguments,
    { signal, timeoutMs = 15 * 60_000 } = {},
  ) {
    const args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script(scriptName),
    ];
    for (const [name, value] of Object.entries(namedArguments)) {
      if (value == null || value === "") continue;
      args.push(`-${name}`, String(value));
    }
    let result;
    try {
      result = await this.processRunner(this.config.powershellCommand, args, {
        signal,
        timeoutMs,
      });
    } catch (error) {
      error.operation = scriptName;
      error.code =
        error.code === "PROCESS_START_FAILED"
          ? "POWERSHELL_NOT_AVAILABLE"
          : "HYPERV_COMMAND_FAILED";
      throw error;
    }
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    const parsed = parseJson(lines.at(-1), null);
    return parsed || { stdout: result.stdout.trim() };
  }

  workerArguments(worker, { requireCredential = true } = {}) {
    const result = {
      VMName: required(worker.vmName, "worker.vmName"),
    };
    if (requireCredential) {
      result.CredentialPath = required(
        worker.credentialPath,
        "worker.credentialPath",
      );
    } else if (worker.credentialPath) {
      result.CredentialPath = worker.credentialPath;
    }
    return result;
  }

  async initialize() {
    return this.inspectRuntime({ force: true });
  }

  runtimeStatus() {
    return this.runtime;
  }

  async inspectRuntime({ force = false } = {}) {
    const fresh = this.runtime && Date.now() - this.runtimeCheckedAt < 10_000;
    if (!force && fresh) return this.runtime;
    if (this.runtimePromise) return this.runtimePromise;
    this.runtimePromise = (async () => {
      const [hyperv, codex] = await Promise.all([
        this.powershell("Get-HostStatus.ps1", {}, { timeoutMs: 45_000 }).catch(
          (error) => ({
            moduleAvailable: false,
            canManage: false,
            vmCount: 0,
            virtualMachines: [],
            error: error.message,
          }),
        ),
        this.codex.inspect(),
      ]);
      hyperv.checkpointsEnabled = this.config.checkpointsEnabled;
      const runtime = {
        ready: Boolean(
          hyperv.moduleAvailable &&
          hyperv.canManage &&
          codex.available &&
          codex.authenticated,
        ),
        checkedAt: new Date().toISOString(),
        checkpointsEnabled: this.config.checkpointsEnabled,
        hyperv,
        codex,
      };
      this.runtime = runtime;
      this.runtimeCheckedAt = Date.now();
      return runtime;
    })();
    try {
      return await this.runtimePromise;
    } finally {
      this.runtimePromise = null;
    }
  }

  async probeWorker(worker) {
    try {
      return await this.powershell(
        "Get-WorkerHealth.ps1",
        {
          ...this.workerArguments(worker, { requireCredential: false }),
          SharePath: worker.sharePath,
          HealthUrl: resolveWorkerTemplate(
            worker.project?.unityHealthUrl || worker.project?.unitySkillUrl,
            worker,
          ),
          TimeoutSeconds: 60,
        },
        { timeoutMs: 90_000 },
      );
    } catch (error) {
      return {
        ready: false,
        vm: false,
        heartbeat: false,
        smb: false,
        unity: false,
        skill: false,
        error: error.message,
      };
    }
  }

  async prepare(context, { signal, onProgress }) {
    if (this.config.checkpointsEnabled) {
      onProgress?.(
        "restore",
        `Restoring ${context.worker.checkpointName || context.project.checkpointName}`,
      );
      await this.powershell(
        "Restore-Worker.ps1",
        {
          ...this.workerArguments(context.worker),
          CheckpointName:
            context.worker.checkpointName ||
            context.project.checkpointName ||
            "PROJECT_READY",
        },
        { signal },
      );
    } else {
      onProgress?.(
        "vm-ready",
        `Ensuring ${context.worker.vmName} and PowerShell Direct are ready`,
      );
      await this.powershell(
        "Ensure-WorkerReady.ps1",
        this.workerArguments(context.worker),
        { signal },
      );
    }
    onProgress?.(
      "workspace",
      `Preparing ${context.task.branchName} inside ${context.worker.vmName}`,
    );
    const result = await this.powershell(
      "Prepare-Workspace.ps1",
      {
        ...this.workerArguments(context.worker),
        GuestProjectPath: required(
          context.project.guestProjectPath,
          "project.guestProjectPath",
        ),
        RepoUrl: required(context.project.repoUrl, "project.repoUrl"),
        BaseBranch: required(context.task.baseBranch, "task.baseBranch"),
        TaskBranch: required(context.task.branchName, "task.branchName"),
        Mode: context.task.codexThreadId ? "resume" : "new",
        GitAuthorName: this.config.gitAuthorName || "Relay Unity Orchestrator",
        GitAuthorEmail:
          this.config.gitAuthorEmail || "relay-unity-orchestrator@localhost",
        SharePath: context.worker.sharePath || context.project.smbPath,
        UnityHealthUrl: resolveWorkerTemplate(
          context.project.unityHealthUrl || context.project.unitySkillUrl,
          context.worker,
        ),
      },
      { signal },
    );
    onProgress?.(
      "unity",
      "Guest Git branch, Unity, SMB, and Unity Skill are ready",
    );
    return result;
  }

  async resumePreserved(context, { signal, onProgress }) {
    onProgress?.(
      "vm-ready",
      `Ensuring ${context.worker.vmName} and PowerShell Direct are ready`,
    );
    await this.powershell(
      "Ensure-WorkerReady.ps1",
      this.workerArguments(context.worker),
      { signal },
    );
    onProgress?.(
      "workspace",
      `Verifying preserved ${context.task.branchName} workspace without resetting it`,
    );
    const result = await this.powershell(
      "Verify-PreservedWorkspace.ps1",
      {
        ...this.workerArguments(context.worker),
        GuestProjectPath: required(
          context.project.guestProjectPath,
          "project.guestProjectPath",
        ),
        TaskBranch: required(context.task.branchName, "task.branchName"),
      },
      { signal },
    );
    const health = await this.probeWorker({
      ...context.worker,
      project: context.project,
    });
    if (!health.ready) {
      throw Object.assign(
        new Error(
          `Preserved workspace is intact, but the worker is not ready: ${health.error || "Unity or Unity Skill is unavailable"}`,
        ),
        { code: "PRESERVED_WORKSPACE_NOT_READY" },
      );
    }
    onProgress?.(
      "unity",
      "Preserved Git branch, Unity, SMB, and Unity Skill are ready",
    );
    return { ...result, preserved: true };
  }

  runCodex(context, options) {
    return this.codex.run(context, options);
  }

  async finalize(context, { signal, onProgress }) {
    const unitySaveUrl = resolveWorkerTemplate(
      context.project.unitySaveUrl,
      context.worker,
    );
    if (!unitySaveUrl && !this.config.allowUnitySaveSkip) {
      throw Object.assign(
        new Error(
          "unitySaveUrl is required before a Hyper-V worker can be released",
        ),
        {
          code: "UNITY_SAVE_NOT_CONFIGURED",
        },
      );
    }
    if (unitySaveUrl) {
      onProgress?.("unity-save", "Saving all Unity assets through Unity Skill");
      await this.powershell(
        "Save-UnityProject.ps1",
        {
          ...this.workerArguments(context.worker),
          UnitySaveUrl: unitySaveUrl,
        },
        { signal, timeoutMs: 120_000 },
      );
    }
    onProgress?.("commit", "Committing changes inside the guest");
    onProgress?.(
      "push",
      `Pushing ${context.task.branchName} and verifying remote SHA`,
    );
    return this.powershell(
      "Finalize-Workspace.ps1",
      {
        ...this.workerArguments(context.worker),
        GuestProjectPath: required(
          context.project.guestProjectPath,
          "project.guestProjectPath",
        ),
        TaskBranch: required(context.task.branchName, "task.branchName"),
        CommitMessage: `task #${context.task.number} turn ${context.turn.sequence}: ${context.task.title}`,
        GitAuthorName: this.config.gitAuthorName || "Relay Unity Orchestrator",
        GitAuthorEmail:
          this.config.gitAuthorEmail || "relay-unity-orchestrator@localhost",
      },
      { signal },
    );
  }

  async release(context, { signal, onProgress }) {
    if (!this.config.checkpointsEnabled) {
      onProgress?.(
        "release",
        "Checkpoint restore is disabled; leaving the delivered workspace in place",
      );
      return {
        ready: true,
        checkpointRestored: false,
      };
    }
    onProgress?.(
      "release",
      `Restoring ${context.worker.checkpointName || context.project.checkpointName}`,
    );
    return this.powershell(
      "Restore-Worker.ps1",
      {
        ...this.workerArguments(context.worker),
        CheckpointName:
          context.worker.checkpointName ||
          context.project.checkpointName ||
          "PROJECT_READY",
      },
      { signal },
    );
  }

  async controlWorker(worker, action) {
    if (action === "restore" && !this.config.checkpointsEnabled) {
      throw Object.assign(
        new Error(
          "Checkpoint operations are disabled until PIPELINE_CHECKPOINTS_ENABLED=true",
        ),
        { code: "CHECKPOINTS_DISABLED" },
      );
    }
    if (action === "release" && !this.config.checkpointsEnabled) {
      return { action, checkpointRestored: false };
    }
    if (action === "restore" || action === "release") {
      return this.powershell("Restore-Worker.ps1", {
        ...this.workerArguments(worker),
        CheckpointName: worker.checkpointName || "PROJECT_READY",
      });
    }
    if (action === "probe") return this.probeWorker(worker);
    const result = await this.powershell("Control-Worker.ps1", {
      VMName: required(worker.vmName, "worker.vmName"),
      Action: action,
    });
    if (["start", "restart"].includes(action)) {
      await this.powershell(
        "Ensure-WorkerReady.ps1",
        this.workerArguments(worker),
        { timeoutMs: 270_000 },
      );
    }
    return result;
  }
}
