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
  constructor(config) {
    this.config = config;
    this.codex = new CodexRunner(config);
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
    const result = await runProcess(this.config.powershellCommand, args, {
      signal,
      timeoutMs,
    });
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    const parsed = parseJson(lines.at(-1), null);
    return parsed || { stdout: result.stdout.trim() };
  }

  commonWorkerArguments(worker) {
    return {
      VMName: required(worker.vmName, "worker.vmName"),
      CredentialPath: required(worker.credentialPath, "worker.credentialPath"),
    };
  }

  async probeWorker(worker) {
    try {
      return await this.powershell(
        "Get-WorkerHealth.ps1",
        {
          ...this.commonWorkerArguments(worker),
          SharePath: worker.sharePath,
          HealthUrl: resolveWorkerTemplate(
            worker.project?.unityHealthUrl || worker.project?.unitySkillUrl,
            worker,
          ),
        },
        { timeoutMs: 45_000 },
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
    onProgress?.(
      "restore",
      `Restoring ${context.worker.checkpointName || context.project.checkpointName}`,
    );
    await this.powershell(
      "Restore-Worker.ps1",
      {
        ...this.commonWorkerArguments(context.worker),
        CheckpointName:
          context.worker.checkpointName ||
          context.project.checkpointName ||
          "PROJECT_READY",
      },
      { signal },
    );
    onProgress?.(
      "workspace",
      `Preparing ${context.task.branchName} inside ${context.worker.vmName}`,
    );
    const result = await this.powershell(
      "Prepare-Workspace.ps1",
      {
        ...this.commonWorkerArguments(context.worker),
        GuestProjectPath: required(
          context.project.guestProjectPath,
          "project.guestProjectPath",
        ),
        RepoUrl: required(context.project.repoUrl, "project.repoUrl"),
        BaseBranch: required(context.task.baseBranch, "task.baseBranch"),
        TaskBranch: required(context.task.branchName, "task.branchName"),
        Mode: context.task.codexThreadId ? "resume" : "new",
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
          ...this.commonWorkerArguments(context.worker),
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
        ...this.commonWorkerArguments(context.worker),
        GuestProjectPath: required(
          context.project.guestProjectPath,
          "project.guestProjectPath",
        ),
        TaskBranch: required(context.task.branchName, "task.branchName"),
        CommitMessage: `task #${context.task.number} turn ${context.turn.sequence}: ${context.task.title}`,
      },
      { signal },
    );
  }

  async release(context, { signal, onProgress }) {
    onProgress?.(
      "release",
      `Restoring ${context.worker.checkpointName || context.project.checkpointName}`,
    );
    return this.powershell(
      "Restore-Worker.ps1",
      {
        ...this.commonWorkerArguments(context.worker),
        CheckpointName:
          context.worker.checkpointName ||
          context.project.checkpointName ||
          "PROJECT_READY",
      },
      { signal },
    );
  }

  async controlWorker(worker, action) {
    if (action === "restore" || action === "release") {
      return this.powershell("Restore-Worker.ps1", {
        ...this.commonWorkerArguments(worker),
        CheckpointName: worker.checkpointName || "PROJECT_READY",
      });
    }
    if (action === "probe") return this.probeWorker(worker);
    return this.powershell("Control-Worker.ps1", {
      VMName: required(worker.vmName, "worker.vmName"),
      Action: action,
    });
  }
}
