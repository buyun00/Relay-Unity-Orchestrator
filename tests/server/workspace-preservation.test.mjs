import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const guestScript = path.resolve("scripts/hyperv/Prepare-Workspace.Guest.ps1");
const taskBranch = "codex/task-0042-preserve-incident";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createRepository(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-workspace-preserve-"),
  );
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(root, "init", "--bare", "-q", remote);
  git(root, "init", "-q", "-b", "main", seed);
  write(path.join(seed, "Packages", "manifest.json"), '{"base":1}\n');
  write(path.join(seed, "Packages", "packages-lock.json"), '{"lock":1}\n');
  write(path.join(seed, "Assets", "Tournament", "Tracked.asset"), "base\n");
  git(seed, "add", ".");
  git(
    seed,
    "-c",
    "user.name=Relay Test",
    "-c",
    "user.email=relay@test.invalid",
    "commit",
    "-q",
    "-m",
    "base",
  );
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "-u", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  return { root, remote };
}

function clone(repository, name) {
  const project = path.join(repository.root, name);
  git(repository.root, "clone", "-q", repository.remote, project);
  return project;
}

function prepare(project, repository, branch = taskBranch) {
  const stdout = execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      guestScript,
      "-ProjectPath",
      project,
      "-RepositoryUrl",
      repository.remote,
      "-Base",
      "main",
      "-Branch",
      branch,
      "-RequestedMode",
      "new",
      "-AuthorName",
      "Relay Test",
      "-AuthorEmail",
      "relay@test.invalid",
      "-OutputJson",
    ],
    { cwd: path.resolve("."), encoding: "utf8", windowsHide: true },
  );
  return JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
}

function refs(project, ...prefixes) {
  return git(project, "for-each-ref", "--format=%(refname)", ...prefixes)
    .split(/\r?\n/u)
    .filter(Boolean);
}

test("safe Packages changes and an untracked meta file are preserved before target checkout", (t) => {
  const repository = createRepository(t);
  const project = clone(repository, "guest-safe");
  const manifest = path.join(project, "Packages", "manifest.json");
  const packageLock = path.join(project, "Packages", "packages-lock.json");
  const meta = path.join(
    project,
    "Assets",
    "Tournament",
    "Incident.prefab.meta",
  );
  const manifestContent = '{"base":2,"incident":true}\n';
  const packageLockContent = '{"lock":2,"incident":true}\n';
  const metaContent = "fileFormatVersion: 2\nguid: preserved-guid\n";
  write(manifest, manifestContent);
  write(packageLock, packageLockContent);
  write(meta, metaContent);

  const originalHead = git(project, "rev-parse", "HEAD");
  const result = prepare(project, repository);

  assert.equal(result.ready, true);
  assert.equal(result.originalBranch, "main");
  assert.equal(result.originalHead, originalHead);
  assert.equal(result.source, "origin/main");
  assert.match(
    result.preservedBranch,
    /^relay\/preserved\/codex-task-0042-preserve-incident-\d{8}T\d{9}Z(?:-\d+)?$/u,
  );
  assert.match(result.preservedCommit, /^[0-9a-f]{40}$/u);
  assert.deepEqual(
    result.statusBefore.map(({ code, path: statusPath }) => [code, statusPath]),
    [
      [" M", "Packages/manifest.json"],
      [" M", "Packages/packages-lock.json"],
      ["??", "Assets/Tournament/Incident.prefab.meta"],
    ],
  );
  assert.deepEqual(
    result.preservedFiles
      .map(({ path: preservedPath }) => preservedPath)
      .sort(),
    [
      "Assets/Tournament/Incident.prefab.meta",
      "Packages/manifest.json",
      "Packages/packages-lock.json",
    ],
  );

  git(project, "cat-file", "-e", result.preservedCommit + "^{commit}");
  assert.equal(
    git(project, "rev-parse", "refs/heads/" + result.preservedBranch),
    result.preservedCommit,
  );
  assert.equal(
    git(project, "show", result.preservedCommit + ":Packages/manifest.json") +
      "\n",
    manifestContent,
  );
  assert.equal(
    git(
      project,
      "show",
      result.preservedCommit + ":Packages/packages-lock.json",
    ) + "\n",
    packageLockContent,
  );
  assert.equal(
    git(
      project,
      "show",
      result.preservedCommit + ":Assets/Tournament/Incident.prefab.meta",
    ) + "\n",
    metaContent,
  );

  const preservedChanges = git(
    project,
    "diff",
    "--name-status",
    originalHead,
    result.preservedCommit,
  ).split(/\r?\n/u);
  assert.deepEqual(preservedChanges.sort(), [
    "A\tAssets/Tournament/Incident.prefab.meta",
    "M\tPackages/manifest.json",
    "M\tPackages/packages-lock.json",
  ]);
  assert.equal(
    preservedChanges.some((line) => line.startsWith("D\t")),
    false,
  );

  assert.equal(git(project, "branch", "--show-current"), taskBranch);
  assert.equal(
    git(project, "rev-parse", "HEAD"),
    git(project, "rev-parse", "origin/main"),
  );
  assert.equal(git(project, "status", "--porcelain"), "");
  assert.equal(fs.existsSync(manifest), true);
  assert.equal(fs.existsSync(packageLock), true);
});

test("a tracked deletion stops without checkout, preservation, or status changes", (t) => {
  const repository = createRepository(t);
  const project = clone(repository, "guest-deletion");
  const deletedPath = "Assets/Tournament/Tracked.asset";
  fs.unlinkSync(path.join(project, ...deletedPath.split("/")));
  const originalBranch = git(project, "branch", "--show-current");
  const originalHead = git(project, "rev-parse", "HEAD");
  const originalStatus = git(project, "status", "--porcelain=v1");

  const result = prepare(project, repository, "codex/task-delete-refusal");

  assert.equal(result.ready, false);
  assert.equal(result.code, "WORKSPACE_UNSAFE_CHANGES");
  assert.deepEqual(result.deletionPaths, [deletedPath]);
  assert.deepEqual(result.blockedPaths, [deletedPath]);
  assert.equal(git(project, "branch", "--show-current"), originalBranch);
  assert.equal(git(project, "rev-parse", "HEAD"), originalHead);
  assert.equal(git(project, "status", "--porcelain=v1"), originalStatus);
  assert.deepEqual(
    refs(
      project,
      "refs/heads/relay/preserved",
      "refs/heads/codex/task-delete-refusal",
    ),
    [],
  );
});

test("sensitive, log, cache, and build paths stop non-destructively", (t) => {
  const repository = createRepository(t);
  const project = clone(repository, "guest-prohibited");
  const contents = new Map([
    ["secrets/signing.key", "private-key-material\n"],
    ["Logs/incident.log", "diagnostic log\n"],
    ["Library/cache.db", "cache\n"],
    ["Build/player.exe", "build artifact\n"],
  ]);
  for (const [relativePath, content] of contents) {
    write(path.join(project, ...relativePath.split("/")), content);
  }
  const originalBranch = git(project, "branch", "--show-current");
  const originalHead = git(project, "rev-parse", "HEAD");
  const originalStatus = git(project, "status", "--porcelain=v1");

  const result = prepare(project, repository, "codex/task-prohibited-refusal");

  assert.equal(result.ready, false);
  assert.equal(result.code, "WORKSPACE_UNSAFE_CHANGES");
  assert.deepEqual(result.blockedPaths.sort(), [...contents.keys()].sort());
  assert.deepEqual(
    [
      ...new Set(result.prohibitedPaths.flatMap((item) => item.categories)),
    ].sort(),
    ["build", "cache", "log", "sensitive"],
  );
  assert.equal(git(project, "branch", "--show-current"), originalBranch);
  assert.equal(git(project, "rev-parse", "HEAD"), originalHead);
  assert.equal(git(project, "status", "--porcelain=v1"), originalStatus);
  assert.deepEqual(
    refs(
      project,
      "refs/heads/relay/preserved",
      "refs/heads/codex/task-prohibited-refusal",
    ),
    [],
  );
  for (const [relativePath, content] of contents) {
    assert.equal(
      fs.readFileSync(path.join(project, ...relativePath.split("/")), "utf8"),
      content,
    );
  }
});
