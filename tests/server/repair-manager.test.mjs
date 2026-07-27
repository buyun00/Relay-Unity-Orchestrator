import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepairManager } from "../../server/repair-manager.mjs";
import { runProcess } from "../../server/process.mjs";

const gitCommand =
  "C:\\Users\\lin0\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\git\\cmd\\git.exe";

class MemoryRepairStore {
  constructor() {
    this.repairs = [];
    this.events = [];
  }

  createRepairRun({ opsTurnId, incidentId, instructions }) {
    const repair = {
      id: `repair-test-${this.repairs.length + 1}`,
      opsTurnId,
      incidentId,
      instructions,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.repairs.push(repair);
    return { ...repair };
  }

  updateRepairRun(id, changes) {
    const index = this.repairs.findIndex((item) => item.id === id);
    this.repairs[index] = {
      ...this.repairs[index],
      ...changes,
      updatedAt: new Date().toISOString(),
    };
    return { ...this.repairs[index] };
  }

  emit(event) {
    this.events.push(event);
  }
}

async function git(cwd, args) {
  return runProcess(gitCommand, args, { cwd, timeoutMs: 30_000 });
}

async function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-repair-test-"));
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "server", "existing.mjs"),
    "export const value = 1;\n",
  );
  await git(root, ["init", "-b", "main"]);
  await git(root, ["add", "-A"]);
  await git(root, [
    "-c",
    "user.name=Repair Test",
    "-c",
    "user.email=repair-test@localhost",
    "commit",
    "-m",
    "initial",
  ]);
  return root;
}

function createConfig(root, dataDirectory, autoDeploy) {
  return {
    projectRoot: root,
    dataDirectory,
    repairDirectory: path.join(dataDirectory, "repairs"),
    deploymentStatePath: path.join(dataDirectory, "deployment-state.json"),
    logDirectory: path.join(dataDirectory, "logs"),
    gitCommand,
    gitAuthorName: "Relay Repair",
    gitAuthorEmail: "relay-repair@localhost",
    codexCommand: "codex",
    codexModel: "test",
    codexReasoningEffort: "high",
    codexServiceTier: "default",
    codexTimeoutMs: 10_000,
    opsAutoDeploy: autoDeploy,
  };
}

test("self-repair commits, fast-forwards, records deployment, and requests Guardian restart", async (t) => {
  const root = await createRepository();
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-repair-data-"),
  );
  const store = new MemoryRepairStore();
  let restartRequest = null;
  const sessionRunner = {
    async run({ cwd }) {
      fs.writeFileSync(
        path.join(cwd, "server", "existing.mjs"),
        "export const value = 2;\n",
      );
      fs.writeFileSync(
        path.join(cwd, "server", "repair-added.mjs"),
        "export const repaired = true;\n",
      );
      return {
        threadId: "repair-thread",
        final: {
          status: "completed",
          summary: "Fixed the defect",
          changedFiles: ["server/existing.mjs", "server/repair-added.mjs"],
          validation: [],
          risks: [],
        },
      };
    },
  };
  const manager = new RepairManager(
    { config: createConfig(root, dataDirectory, true), store },
    {
      sessionRunner,
      restartCoordinator: {
        async requestDeploymentRestart(value) {
          restartRequest = value;
        },
      },
    },
  );
  manager.validate = async () => [{ name: "test validation", ok: true }];
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  const repair = await manager.run({
    instructions: "Fix the test defect",
  });
  assert.equal(repair.status, "deployed");
  assert.ok(repair.commitSha);
  assert.equal(
    (await git(root, ["rev-parse", "HEAD"])).stdout.trim(),
    repair.commitSha,
  );
  assert.equal(
    fs
      .readFileSync(path.join(root, "server", "existing.mjs"), "utf8")
      .replace(/\r\n/gu, "\n"),
    "export const value = 2;\n",
  );
  assert.ok(restartRequest);
  const deployment = JSON.parse(
    fs.readFileSync(path.join(dataDirectory, "deployment-state.json"), "utf8"),
  );
  assert.equal(deployment.status, "pending");
  assert.equal(deployment.commitSha, repair.commitSha);
});

test("self-repair rejects every file deletion before commit or deployment", async (t) => {
  const root = await createRepository();
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-repair-delete-data-"),
  );
  const store = new MemoryRepairStore();
  const manager = new RepairManager(
    { config: createConfig(root, dataDirectory, false), store },
    {
      sessionRunner: {
        async run({ cwd }) {
          fs.rmSync(path.join(cwd, "server", "existing.mjs"));
          return {
            threadId: "repair-delete-thread",
            final: {
              status: "completed",
              summary: "Deleted a file",
              changedFiles: ["server/existing.mjs"],
              validation: [],
              risks: [],
            },
          };
        },
      },
    },
  );
  manager.validate = async () => [];
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  await assert.rejects(
    manager.run({ instructions: "Attempt an invalid repair" }),
    (error) => error.code === "REPAIR_DELETION_FORBIDDEN",
  );
  assert.equal(
    fs
      .readFileSync(path.join(root, "server", "existing.mjs"), "utf8")
      .replace(/\r\n/gu, "\n"),
    "export const value = 1;\n",
  );
  assert.equal(store.repairs[0].status, "failed");
});
