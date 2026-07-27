import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexSessionRunner } from "./codex-session.mjs";
import { runProcess } from "./process.mjs";
import { now } from "./util.mjs";

const repairSchemaPath = fileURLToPath(
  new URL("./repair-output.schema.json", import.meta.url),
);

function bundledGitPath() {
  const profile = process.env.USERPROFILE;
  if (!profile) return null;
  const candidate = path.join(
    profile,
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "native",
    "git",
    "cmd",
    "git.exe",
  );
  return fs.existsSync(candidate) ? candidate : null;
}

function deletionEntries(text) {
  return String(text || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^D(?:\s|$)/u.test(line));
}

function safeRepairSuffix(repairId) {
  return repairId
    .replace(/[^A-Za-z0-9]/gu, "")
    .slice(-12)
    .toLowerCase();
}

export class RepairManager {
  constructor(
    { config, store },
    {
      processRunner = runProcess,
      sessionRunner = null,
      restartCoordinator = null,
    } = {},
  ) {
    this.config = config;
    this.store = store;
    this.processRunner = processRunner;
    this.sessionRunner =
      sessionRunner || new CodexSessionRunner(config, { processRunner });
    this.restartCoordinator = restartCoordinator;
    this.gitCommand =
      config.gitCommand === "git"
        ? bundledGitPath() || config.gitCommand
        : config.gitCommand;
  }

  async git(args, { cwd = this.config.projectRoot, ...options } = {}) {
    return this.processRunner(this.gitCommand, args, {
      cwd,
      timeoutMs: 10 * 60 * 1000,
      ...options,
    });
  }

  emit(repair, message, level = "info", data = null) {
    this.store.emit({
      opsTurnId: repair.opsTurnId,
      incidentId: repair.incidentId,
      type: "ops.repair.progress",
      phase: "repair",
      level,
      message,
      data: { repairId: repair.id, ...(data || {}) },
    });
  }

  async assertNoDeletions(worktreePath, baseSha) {
    const checks = await Promise.all([
      this.git(["diff", "--name-status", `${baseSha}...HEAD`], {
        cwd: worktreePath,
      }),
      this.git(["diff", "--name-status"], { cwd: worktreePath }),
      this.git(["diff", "--cached", "--name-status"], { cwd: worktreePath }),
    ]);
    const deletions = checks.flatMap((result) =>
      deletionEntries(result.stdout),
    );
    if (deletions.length) {
      throw Object.assign(
        new Error(
          `Automated repair attempted file deletion, which is forbidden: ${deletions.join(", ")}`,
        ),
        { code: "REPAIR_DELETION_FORBIDDEN", details: deletions },
      );
    }
  }

  async validate(worktreePath) {
    const node = process.execPath;
    const commands = [
      {
        name: "typecheck",
        command: node,
        args: [
          path.join(worktreePath, "node_modules", "typescript", "bin", "tsc"),
          "--noEmit",
        ],
      },
      {
        name: "server tests",
        command: node,
        args: [
          "--test",
          ...fs
            .readdirSync(path.join(worktreePath, "tests", "server"))
            .filter((name) => name.endsWith(".test.mjs"))
            .map((name) => path.join(worktreePath, "tests", "server", name)),
        ],
      },
      {
        name: "production build",
        command: node,
        args: [
          path.join(worktreePath, "node_modules", "vinext", "dist", "cli.js"),
          "build",
        ],
        env: {
          WRANGLER_LOG_PATH: path.join(
            worktreePath,
            ".wrangler",
            "wrangler.log",
          ),
        },
      },
      {
        name: "rendered HTML test",
        command: node,
        args: [
          "--test",
          path.join(worktreePath, "tests", "rendered-html.test.mjs"),
        ],
      },
    ];
    const validation = [];
    for (const item of commands) {
      const startedAt = Date.now();
      const result = await this.processRunner(item.command, item.args, {
        cwd: worktreePath,
        env: item.env,
        timeoutMs: 20 * 60 * 1000,
      });
      validation.push({
        name: item.name,
        ok: true,
        durationMs: Date.now() - startedAt,
        output: `${result.stdout || ""}\n${result.stderr || ""}`
          .trim()
          .slice(-8_000),
      });
    }
    return validation;
  }

  async writeDeploymentState(state) {
    fs.mkdirSync(path.dirname(this.config.deploymentStatePath), {
      recursive: true,
    });
    fs.writeFileSync(
      this.config.deploymentStatePath,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
  }

  async run({ opsTurnId = null, incidentId = null, instructions }) {
    let repair = this.store.createRepairRun({
      opsTurnId,
      incidentId,
      instructions,
    });
    const suffix = safeRepairSuffix(repair.id);
    const branchName = `relay/auto-repair-${suffix}`;
    const worktreePath = path.join(this.config.repairDirectory, repair.id);
    try {
      const sourceStatus = await this.git(["status", "--porcelain"]);
      if (sourceStatus.stdout.trim()) {
        throw Object.assign(
          new Error(
            "Relay source worktree is not clean; automated deployment would overwrite concurrent work",
          ),
          { code: "REPAIR_SOURCE_DIRTY" },
        );
      }
      const baseSha = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
      fs.mkdirSync(this.config.repairDirectory, { recursive: true });
      repair = this.store.updateRepairRun(repair.id, {
        status: "running",
        branchName,
        worktreePath,
        baseSha,
      });
      this.emit(repair, `Creating isolated repair worktree ${branchName}`);
      await this.git([
        "worktree",
        "add",
        "-b",
        branchName,
        worktreePath,
        baseSha,
      ]);
      const sourceNodeModules = path.join(
        this.config.projectRoot,
        "node_modules",
      );
      const repairNodeModules = path.join(worktreePath, "node_modules");
      if (
        fs.existsSync(sourceNodeModules) &&
        !fs.existsSync(repairNodeModules)
      ) {
        fs.symlinkSync(sourceNodeModules, repairNodeModules, "junction");
      }

      const prompt = [
        "You are the Relay self-repair engineer operating in an isolated Git worktree.",
        "Diagnose and fix the supplied Relay runtime incident completely.",
        "You may edit code, configuration, scripts, tests, and documentation and may create Git commits.",
        "Never delete files, branches, tags, worktrees, logs, databases, tasks, workers, VMs, or checkpoints.",
        "Do not push and do not modify the source worktree outside the current repair worktree.",
        "Preserve backward compatibility unless the incident requires a deliberate migration.",
        "Run proportionate validation and return the required structured result.",
        "",
        `Incident: ${instructions}`,
      ].join("\n");
      const codex = await this.sessionRunner.run({
        cwd: worktreePath,
        prompt,
        schemaPath: repairSchemaPath,
        logDirectory: path.join(
          this.config.logDirectory,
          "ops",
          "repairs",
          repair.id,
        ),
        logName: "codex",
        sandbox: "workspace-write",
        signal: undefined,
        onEvent: (event) => {
          if (
            event?.type === "item.completed" &&
            event?.item?.type === "agent_message"
          ) {
            this.emit(
              repair,
              String(event.item.text || event.item.message || "").slice(
                0,
                100_000,
              ),
            );
          }
        },
      });
      repair = this.store.updateRepairRun(repair.id, {
        codexThreadId: codex.threadId,
      });
      if (codex.final.status !== "completed") {
        throw Object.assign(
          new Error(codex.final.summary || "Repair Codex reported a block"),
          { code: "REPAIR_CODEX_BLOCKED" },
        );
      }

      await this.assertNoDeletions(worktreePath, baseSha);
      const dirty = (
        await this.git(["status", "--porcelain"], { cwd: worktreePath })
      ).stdout.trim();
      if (dirty) {
        await this.git(["add", "-A"], { cwd: worktreePath });
        await this.assertNoDeletions(worktreePath, baseSha);
        await this.git(
          [
            "-c",
            `user.name=${this.config.gitAuthorName}`,
            "-c",
            `user.email=${this.config.gitAuthorEmail}`,
            "commit",
            "-m",
            `fix(relay): automated repair ${suffix}`,
          ],
          { cwd: worktreePath },
        );
      }
      const commitSha = (
        await this.git(["rev-parse", "HEAD"], { cwd: worktreePath })
      ).stdout.trim();
      if (commitSha === baseSha) {
        throw Object.assign(
          new Error("Repair Codex completed without producing a code change"),
          { code: "REPAIR_NO_CHANGES" },
        );
      }
      await this.assertNoDeletions(worktreePath, baseSha);

      repair = this.store.updateRepairRun(repair.id, {
        status: "validating",
        commitSha,
      });
      this.emit(repair, "Running full repair validation");
      const validation = await this.validate(worktreePath);
      await this.assertNoDeletions(worktreePath, baseSha);
      repair = this.store.updateRepairRun(repair.id, {
        status: "validated",
        validation,
      });

      if (this.config.opsAutoDeploy) {
        const currentSha = (
          await this.git(["rev-parse", "HEAD"])
        ).stdout.trim();
        const currentStatus = (
          await this.git(["status", "--porcelain"])
        ).stdout.trim();
        if (currentSha !== baseSha || currentStatus) {
          throw Object.assign(
            new Error(
              "Relay source changed while repair was running; validated commit was preserved but not deployed",
            ),
            { code: "REPAIR_DEPLOYMENT_RACE" },
          );
        }
        repair = this.store.updateRepairRun(repair.id, {
          status: "deploying",
        });
        await this.git(["merge", "--ff-only", branchName]);
        const deployedAt = now();
        await this.writeDeploymentState({
          version: 1,
          status: "pending",
          repairId: repair.id,
          incidentId,
          baseSha,
          commitSha,
          branchName,
          projectRoot: this.config.projectRoot,
          createdAt: deployedAt,
          attempts: 0,
        });
        repair = this.store.updateRepairRun(repair.id, {
          status: "deployed",
          deployedAt,
        });
        this.emit(
          repair,
          `Repair ${commitSha.slice(0, 12)} fast-forwarded to Relay; Guardian restart requested`,
          "info",
          { commitSha },
        );
        await this.restartCoordinator?.requestDeploymentRestart?.({
          repairId: repair.id,
          commitSha,
        });
      }
      return repair;
    } catch (error) {
      repair = this.store.updateRepairRun(repair.id, {
        status: "failed",
        error: error?.message || String(error),
      });
      this.emit(repair, error?.message || String(error), "error", {
        code: error?.code || "REPAIR_FAILED",
      });
      throw error;
    }
  }
}
