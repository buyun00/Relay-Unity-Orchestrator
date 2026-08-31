import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HyperVAdapter } from "../../server/adapters/hyperv.mjs";

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-local-draft-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Relay test");
  git("config", "user.email", "test@localhost");
  fs.writeFileSync(path.join(root, "file.txt"), "base\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const branch = "codex/task-0133-local-draft";
  git("checkout", "-b", branch);
  fs.writeFileSync(path.join(root, "file.txt"), "unpublished task work\n");
  fs.writeFileSync(path.join(root, "ignored.txt"), "tracked task file\n");
  git("add", "file.txt");
  git("add", "-f", "ignored.txt");
  git("commit", "-m", "draft");
  const draft = git("rev-parse", "HEAD");
  git("checkout", "main");
  const resume = (overrides = {}) =>
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("scripts/hyperv/Resume-LocalTaskBranch.Guest.ps1"),
        "-ProjectPath",
        root,
        "-TaskBranch",
        overrides.branch || branch,
        "-ExpectedCurrentBranch",
        "main",
        "-ExpectedCurrentHead",
        overrides.head || base,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 20_000 },
    );
  return { root, git, base, branch, draft, resume };
}

test("a real unpublished local commit resumes with no remote and preserves the prior branch", (t) => {
  const r = repository(t);
  const result = r.resume();
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.head, r.draft);
  assert.equal(value.localDraft, true);
  assert.equal(r.git("rev-parse", "main"), r.base);
  assert.equal(r.git("status", "--porcelain"), "");
  assert.equal(r.git("remote"), "");
});

for (const kind of [
  "tracked",
  "untracked",
  "ignored",
  "missing",
  "head changed",
]) {
  test(`local draft resume preserves current workspace on ${kind} conflict`, (t) => {
    const r = repository(t);
    const file =
      kind === "tracked"
        ? "file.txt"
        : kind === "ignored"
          ? "ignored.txt"
          : "untracked.txt";
    if (["tracked", "untracked", "ignored"].includes(kind))
      fs.writeFileSync(path.join(r.root, file), "must preserve\n");
    const result = r.resume(
      kind === "missing"
        ? { branch: "codex/task-0999-missing" }
        : kind === "head changed"
          ? { head: "a".repeat(40) }
          : {},
    );
    assert.notEqual(result.status, 0);
    assert.equal(r.git("branch", "--show-current"), "main");
    assert.equal(r.git("rev-parse", "HEAD"), r.base);
    assert.equal(r.git("rev-parse", r.branch), r.draft);
    if (["tracked", "untracked", "ignored"].includes(kind))
      assert.equal(
        fs.readFileSync(path.join(r.root, file), "utf8"),
        "must preserve\n",
      );
  });
}

test("adapter resumes an established unpublished task locally without remote recovery", async () => {
  const c = {
    worker: { vmName: "fixture" },
    project: { guestProjectPath: "D:\\fixture" },
    task: {
      branchName: "codex/task-0133-local-draft",
      codexThreadId: "original",
      latestCommitSha: null,
    },
  };
  const calls = [];
  const adapter = new HyperVAdapter({}, { codex: {} });
  adapter.powershell = async (name) => {
    calls.push(name);
    return name === "Inspect-PreservedWorkspace.ps1"
      ? {
          ready: true,
          repositoryExists: true,
          branch: "main",
          head: "a".repeat(40),
          audit: { changes: [] },
        }
      : {
          ready: true,
          localDraft: true,
          branch: c.task.branchName,
          head: "b".repeat(40),
          originalBranch: "main",
          originalHead: "a".repeat(40),
        };
  };
  adapter.workerArguments = () => ({});
  adapter.probeWorker = async () => ({ ready: true });
  const result = await adapter.resumePreserved(c, {});
  assert.equal(result.localDraft, true);
  assert.equal(c.task.latestCommitSha, null);
  assert.deepEqual(calls, [
    "Inspect-PreservedWorkspace.ps1",
    "Resume-LocalTaskBranch.ps1",
  ]);
});
