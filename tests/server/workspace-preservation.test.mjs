import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const guestScript = path.resolve("scripts/hyperv/Prepare-Workspace.Guest.ps1");
const inspectGuestScript = path.resolve(
  "scripts/hyperv/Inspect-PreservedWorkspace.Guest.ps1",
);
const recoverHostScript = path.resolve("scripts/hyperv/Recover-Workspace.ps1");
const taskBranch = "codex/task-0017-task";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function gitWithEnvironment(cwd, environment, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    windowsHide: true,
  }).trim();
}

function gitNulFields(cwd, ...args) {
  const output = execFileSync("git", args, {
    cwd,
    encoding: "buffer",
    windowsHide: true,
  });
  if (output.length === 0) return [];
  assert.equal(output.at(-1), 0, "Git -z output must end with NUL");
  return output.subarray(0, -1).toString("utf8").split("\0");
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
  git(seed, "config", "core.autocrlf", "false");
  write(
    path.join(seed, "baloot_client", "Packages", "manifest.json"),
    '{"base":1}\n',
  );
  write(
    path.join(seed, "baloot_client", "Packages", "packages-lock.json"),
    '{"lock":1}\n',
  );
  write(
    path.join(seed, "baloot_client", "Assets", "Tournament", "Tracked.asset"),
    "base\n",
  );
  write(
    path.join(seed, "baloot_client", "Assets", "中文 技能", "旧 名称.asset"),
    "rename-base\n",
  );
  for (let index = 0; index < 48; index += 1) {
    write(
      path.join(
        seed,
        ".codex",
        "skills",
        `技能 ${String(index).padStart(2, "0")}`,
        "说明 文档.md",
      ),
      `baseline skill ${index}\n`,
    );
  }
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
  git(
    repository.root,
    "-c",
    "core.autocrlf=false",
    "clone",
    "-q",
    repository.remote,
    project,
  );
  git(project, "config", "core.autocrlf", "false");
  return project;
}

function inspect(project) {
  const stdout = execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      inspectGuestScript,
      "-ProjectPath",
      project,
      "-OutputJson",
    ],
    { cwd: path.resolve("."), encoding: "utf8", windowsHide: true },
  );
  return JSON.parse(stdout.trim());
}

function prepare(
  project,
  repository,
  branch = taskBranch,
  mode = "new",
  audit = null,
) {
  const args = [
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
    mode,
    "-AuthorName",
    "Relay Test",
    "-AuthorEmail",
    "relay@test.invalid",
  ];
  if (audit) args.push("-AuditJson", JSON.stringify(audit));
  args.push("-OutputJson");
  const stdout = execFileSync("powershell.exe", args, {
    cwd: path.resolve("."),
    encoding: "utf8",
    windowsHide: true,
  });
  return JSON.parse(stdout.trim());
}

function refs(project, ...prefixes) {
  return git(project, "for-each-ref", "--format=%(refname)", ...prefixes)
    .split(/\r?\n/u)
    .filter(Boolean);
}

function runRecoveryHostWrapper(t, guestPayload, { throwGuest = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-host-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credentialPath = path.join(root, "credential.xml");
  const payloadBase64 = Buffer.from(
    JSON.stringify(guestPayload ?? {}),
    "utf8",
  ).toString("base64");
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    `$credential = New-Object System.Management.Automation.PSCredential('relay-test', (ConvertTo-SecureString 'test' -AsPlainText -Force))`,
    `$credential | Export-Clixml -LiteralPath ${quote(credentialPath)}`,
    `$global:relayGuestJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payloadBase64}'))`,
    "$global:relayInvokeCount = 0",
    `function global:Invoke-Command {
      param(
        [string]$VMName,
        [pscredential]$Credential,
        [object[]]$ArgumentList,
        [scriptblock]$ScriptBlock
      )
      $global:relayInvokeCount += 1
      if ($global:relayInvokeCount -eq 1) {
        if (${throwGuest ? "$true" : "$false"}) {
          throw '模拟 guest exception'
        }
        $decorated = [psobject]$global:relayGuestJson
        $decorated | Add-Member NoteProperty PSComputerName 'guest-01' -Force
        $decorated | Add-Member NoteProperty RunspaceId ([Guid]::NewGuid()) -Force
        $decorated | Add-Member NoteProperty PSShowComputerName $true -Force
        return $decorated
      }
      return $true
    }`,
    `& ${quote(recoverHostScript)} -VMName 'fake-vm' -CredentialPath ${quote(
      credentialPath,
    )} -GuestProjectPath 'D:\\Work\\中文 Project' -RepoUrl 'https://example.test/repo.git' -BaseBranch 'main' -TaskBranch ${quote(
      taskBranch,
    )} -AuditJson '{}' -TimeoutSeconds 30`,
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-EncodedCommand", encoded],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      windowsHide: true,
    },
  );
}

test("recovery preserves every tracked and untracked task-0017 file before target checkout", (t) => {
  const repository = createRepository(t);
  const project = clone(repository, "guest-safe");
  const manifestPath = "baloot_client/Packages/manifest.json";
  const packageLockPath = "baloot_client/Packages/packages-lock.json";
  const metaPath =
    "baloot_client/Assets/AppAssets/hall/scripts/Common/Automation.meta";
  const manifest = path.join(project, ...manifestPath.split("/"));
  const packageLock = path.join(project, ...packageLockPath.split("/"));
  const meta = path.join(project, ...metaPath.split("/"));
  const manifestContent = '{"base":2,"incident":true}\n';
  const packageLockContent = '{"lock":2,"incident":true}\n';
  const metaContent = "fileFormatVersion: 2\nguid: preserved-guid\n";
  write(manifest, manifestContent);
  write(packageLock, packageLockContent);
  write(meta, metaContent);

  const originalHead = git(project, "rev-parse", "HEAD");
  const workspacePathsBefore = gitNulFields(
    project,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ).sort();
  const inspection = inspect(project);
  const result = prepare(
    project,
    repository,
    taskBranch,
    "recovery",
    inspection.audit,
  );

  assert.equal(result.ready, true, JSON.stringify(result, null, 2));
  assert.equal(result.proofVersion, 1);
  assert.equal(result.proven, true);
  assert.equal(result.originalBranch, "main");
  assert.equal(result.originalHead, originalHead);
  assert.equal(result.auditedHead, originalHead);
  assert.equal(result.auditFingerprint, inspection.audit.fingerprint);
  assert.equal(result.source, "origin/main");
  assert.equal(result.preservationVerified, true);
  assert.equal(result.preservationBranch, result.preservedBranch);
  assert.equal(result.preservationCommit, result.preservedCommit);
  assert.equal(result.preservationParent, originalHead);
  assert.equal(result.reused, false);
  assert.equal(result.parentVerified, true);
  assert.equal(result.nameStatusVerified, true);
  assert.equal(result.treeVerified, true);
  assert.equal(result.blobVerified, true);
  assert.deepEqual(result.verifiedFiles, result.preservedFiles);
  assert.deepEqual(result.statusAfter, []);
  assert.equal(result.taskBranch, taskBranch);
  assert.equal(result.taskBranchCreated, true);
  assert.equal(result.currentBranch, taskBranch);
  assert.equal(result.preTargetCheckoutBranch, "main");
  assert.equal(result.preTargetCheckoutHead, originalHead);
  assert.match(
    result.preservedBranch,
    /^relay\/preserved\/task-0017-task-\d{8}T\d{9}Z-[0-9a-f]{12}$/u,
  );
  assert.match(result.preservedCommit, /^[0-9a-f]{40}$/u);
  assert.match(result.preservedTree, /^[0-9a-f]{40}$/u);
  assert.equal(
    git(project, "rev-parse", result.preservedCommit + "^"),
    originalHead,
  );
  assert.ok(
    result.porcelainV2Before.some((line) =>
      line.startsWith("# branch.head main"),
    ),
  );
  assert.deepEqual(result.untrackedFilesBefore, [metaPath]);
  assert.deepEqual(
    result.statusBefore.map(({ code, path: statusPath }) => [code, statusPath]),
    [
      [" M", manifestPath],
      [" M", packageLockPath],
      ["??", metaPath],
    ],
  );
  assert.deepEqual(
    result.preservedFiles
      .map(({ path: preservedPath }) => preservedPath)
      .sort(),
    [manifestPath, packageLockPath, metaPath].sort(),
  );
  for (const preservedFile of result.preservedFiles) {
    const auditedFile = inspection.audit.changes.find(
      (file) => file.path === preservedFile.path,
    );
    assert.equal(preservedFile.auditBlob, auditedFile.auditBlob);
    assert.equal(preservedFile.preservedBlob, auditedFile.auditBlob);
  }
  assert.deepEqual(
    result.preservedNameStatus
      .map(({ status, path: changedPath }) => `${status}\t${changedPath}`)
      .sort(),
    [`A\t${metaPath}`, `M\t${manifestPath}`, `M\t${packageLockPath}`].sort(),
  );

  git(project, "cat-file", "-e", result.preservedCommit + "^{commit}");
  assert.equal(
    git(project, "rev-parse", "refs/heads/" + result.preservedBranch),
    result.preservedCommit,
  );
  assert.equal(
    git(project, "show", result.preservedCommit + ":" + manifestPath) + "\n",
    manifestContent,
  );
  assert.equal(
    git(project, "show", result.preservedCommit + ":" + packageLockPath) + "\n",
    packageLockContent,
  );
  assert.equal(
    git(project, "show", result.preservedCommit + ":" + metaPath) + "\n",
    metaContent,
  );

  const preservedChanges = git(
    project,
    "diff",
    "--name-status",
    originalHead,
    result.preservedCommit,
  ).split(/\r?\n/u);
  assert.deepEqual(
    preservedChanges.sort(),
    [`A\t${metaPath}`, `M\t${manifestPath}`, `M\t${packageLockPath}`].sort(),
  );
  assert.equal(
    preservedChanges.some((line) => line.startsWith("D\t")),
    false,
  );
  assert.deepEqual(
    gitNulFields(
      project,
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      result.preservedCommit,
    ).sort(),
    workspacePathsBefore,
  );
  assert.doesNotMatch(JSON.stringify(result), /unexpected: \./u);
  assert.equal(
    result.preservedNameStatus.some(
      ({ path: changedPath }) => changedPath === ".",
    ),
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
  const checkoutHistory = git(project, "reflog", "--format=%gs", "HEAD");
  assert.match(
    checkoutHistory,
    new RegExp(
      `checkout: moving from main to ${result.preservedBranch.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`,
      "u",
    ),
  );
});

test("a large Chinese tracked baseline is tree context, not an audited untracked diff", (t) => {
  const repository = createRepository(t);
  const project = clone(repository, "guest-untracked-only");
  const metaPath =
    "baloot_client/Assets/AppAssets/中文 自动化/Common/Automation meta.meta";
  const metaContent = "fileFormatVersion: 2\nguid: only-untracked\n";
  write(path.join(project, ...metaPath.split("/")), metaContent);
  const originalHead = git(project, "rev-parse", "HEAD");
  const inspection = inspect(project);

  assert.deepEqual(
    inspection.audit.changes.map(({ code, path: auditedPath }) => [
      code,
      auditedPath,
    ]),
    [["??", metaPath]],
  );
  const result = prepare(
    project,
    repository,
    taskBranch,
    "recovery",
    inspection.audit,
  );

  assert.equal(result.ready, true, JSON.stringify(result, null, 2));
  assert.equal(
    git(project, "rev-parse", result.preservedCommit + "^"),
    originalHead,
  );
  assert.deepEqual(
    result.preservedNameStatus.map(({ status, path: changedPath }) => [
      status[0],
      changedPath,
    ]),
    [["A", metaPath]],
  );
  assert.equal(result.preservedFiles.length, 1);
  assert.equal(
    result.preservedFiles[0].preservedBlob,
    inspection.audit.changes[0].auditBlob,
  );
  const treePaths = gitNulFields(
    project,
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    result.preservedCommit,
  );
  assert.equal(
    treePaths.filter((treePath) => treePath.startsWith(".codex/skills/"))
      .length,
    48,
  );
  assert.equal(treePaths.includes(metaPath), true);
  assert.equal(
    result.preservedNameStatus.some(({ path: changedPath }) =>
      changedPath.startsWith(".codex/skills/"),
    ),
    false,
  );
  assert.doesNotMatch(JSON.stringify(result), /unexpected: \./u);
});

test("preservation parent remains the audited local HEAD when main is 39 commits behind origin", (t) => {
  const repository = createRepository(t);
  const project = clone(repository, "guest-behind-origin");
  const auditedHead = git(project, "rev-parse", "HEAD");
  const untrackedPath = "baloot_client/Assets/延迟 主线/Automation.meta";
  write(path.join(project, ...untrackedPath.split("/")), "behind-origin\n");

  for (let index = 1; index <= 39; index += 1) {
    write(
      path.join(
        repository.root,
        "seed",
        "remote-advances",
        `advance-${String(index).padStart(2, "0")}.txt`,
      ),
      `remote ${index}\n`,
    );
    git(repository.root + path.sep + "seed", "add", ".");
    git(
      repository.root + path.sep + "seed",
      "-c",
      "user.name=Relay Test",
      "-c",
      "user.email=relay@test.invalid",
      "commit",
      "-q",
      "-m",
      `remote advance ${index}`,
    );
  }
  git(repository.root + path.sep + "seed", "push", "-q", "origin", "main");

  const inspection = inspect(project);
  const result = prepare(
    project,
    repository,
    taskBranch,
    "recovery",
    inspection.audit,
  );

  assert.equal(
    git(project, "rev-parse", result.preservedCommit + "^"),
    auditedHead,
  );
  assert.equal(
    git(project, "rev-list", "--count", `${auditedHead}..origin/main`),
    "39",
  );
  assert.equal(
    git(project, "rev-parse", "HEAD"),
    git(project, "rev-parse", "origin/main"),
  );
  assert.deepEqual(
    result.preservedNameStatus.map(({ status, path: changedPath }) => [
      status[0],
      changedPath,
    ]),
    [["A", untrackedPath]],
  );
  assert.equal(
    gitNulFields(
      project,
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      result.preservedCommit,
    ).includes("remote-advances/advance-39.txt"),
    false,
  );
});

test("NUL-safe audit preserves Chinese, spaces, newlines, and a tracked rename", (t) => {
  const repository = createRepository(t);
  const project = clone(repository, "guest-unicode-rename");
  const originalPath = "baloot_client/Assets/中文 技能/旧 名称.asset";
  const renamedPath = "baloot_client/Assets/中文 技能/新 名称.asset";
  const untrackedPath = "baloot_client/Assets/中文 技能/自动化 换行 meta.asset";
  git(project, "mv", originalPath, renamedPath);
  write(path.join(project, ...untrackedPath.split("/")), "unicode-path\n");
  const inspection = inspect(project);

  assert.equal(
    inspection.audit.changes.some(
      ({ code, path: auditedPath, originalPath: auditedOriginal }) =>
        code.includes("R") &&
        auditedPath === renamedPath &&
        auditedOriginal === originalPath,
    ),
    true,
  );
  assert.equal(
    inspection.audit.changes.some(
      ({ code, path: auditedPath }) =>
        code === "??" && auditedPath === untrackedPath,
    ),
    true,
  );
  const result = prepare(
    project,
    repository,
    taskBranch,
    "recovery",
    inspection.audit,
  );

  const rename = result.preservedNameStatus.find(({ status }) =>
    status.startsWith("R"),
  );
  assert.equal(rename.originalPath, originalPath);
  assert.equal(rename.path, renamedPath);
  assert.equal(
    result.preservedNameStatus.some(
      ({ status, path: changedPath }) =>
        status.startsWith("A") && changedPath === untrackedPath,
    ),
    true,
  );
  for (const audited of inspection.audit.changes) {
    const preserved = result.preservedFiles.find(
      ({ path: preservedPath }) => preservedPath === audited.path,
    );
    assert.equal(preserved.auditBlob, audited.auditBlob);
    assert.equal(preserved.preservedBlob, audited.auditBlob);
  }
  const treePaths = gitNulFields(
    project,
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    result.preservedCommit,
  );
  assert.equal(treePaths.includes(originalPath), false);
  assert.equal(treePaths.includes(renamedPath), true);
  assert.equal(treePaths.includes(untrackedPath), true);
  assert.equal(treePaths.includes("."), false);
});

test("the raw NUL parser preserves an embedded newline instead of joining records", () => {
  const helperPath = path
    .resolve("scripts/hyperv/Workspace-Git.ps1")
    .replaceAll("'", "''");
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    `. '${helperPath}'`,
    '$text = "M" + [char]0 + "中文 路径`n文件.asset" + [char]0',
    "$bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($text)",
    "@(ConvertFrom-RelayNulFields $bytes) | ConvertTo-Json -Compress",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const output = execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-EncodedCommand", encoded],
    { encoding: "utf8", windowsHide: true },
  );
  assert.deepEqual(JSON.parse(output.trim()), ["M", "中文 路径\n文件.asset"]);
});

test("the real host recovery wrapper emits one clean JSON proof through simulated PS Direct", (t) => {
  const auditedPath = "baloot_client/Assets/中文 恢复\nAutomation.meta";
  const auditBlob = "3033568a1999ebaf6328b316315239ed67cd19a5";
  const auditedHead = "1".repeat(40);
  const preservationBranch =
    "relay/preserved/task-0017-task-20260727T120000000Z-abcdef123456";
  const preservationCommit = "2".repeat(40);
  const verifiedFiles = [
    {
      path: auditedPath,
      code: "??",
      originalPath: null,
      auditBlob,
      preservedBlob: auditBlob,
    },
  ];
  const guestPayload = {
    proofVersion: 1,
    proven: true,
    auditFingerprint: "a".repeat(64),
    auditedHead,
    preservationBranch,
    preservationCommit,
    preservationParent: auditedHead,
    reused: true,
    parentVerified: true,
    nameStatusVerified: true,
    treeVerified: true,
    blobVerified: true,
    verifiedFiles,
    statusAfter: [],
    taskBranch,
    taskBranchCreated: true,
    currentBranch: taskBranch,
    ready: true,
    projectPath: "D:\\Work\\中文 Project",
    branch: taskBranch,
    head: "3".repeat(40),
    source: "origin/main",
    originalBranch: "main",
    originalHead: auditedHead,
    statusBefore: [{ code: "??", path: auditedPath, originalPath: null }],
    porcelainV2Before: ["# branch.head main", `? ${auditedPath}`],
    untrackedFilesBefore: [auditedPath],
    auditedFiles: verifiedFiles,
    preservedBranch: preservationBranch,
    preservedCommit: preservationCommit,
    preservedTree: "4".repeat(40),
    preservedNameStatus: [
      { status: "A", path: auditedPath, originalPath: null },
    ],
    preservedFiles: verifiedFiles,
    reusedPreservation: true,
    preservationVerified: true,
    preTargetCheckoutBranch: "main",
    preTargetCheckoutHead: auditedHead,
    stdoutBytes: [0, 10, 255],
    PSComputerName: "polluting-guest",
  };

  const completed = runRecoveryHostWrapper(t, guestPayload);

  assert.equal(completed.status, 0, completed.stderr);
  const stdout = completed.stdout.trim();
  assert.equal(stdout.split(/\r?\n/u).length, 1);
  const proof = JSON.parse(stdout);
  assert.equal(proof.proofVersion, 1);
  assert.equal(proof.proven, true);
  assert.equal(proof.reused, true);
  assert.equal(proof.preservationParent, auditedHead);
  assert.equal(proof.verifiedFiles[0].path, auditedPath);
  assert.equal(proof.verifiedFiles[0].preservedBlob, auditBlob);
  assert.deepEqual(proof.statusAfter, []);
  assert.equal(proof.currentBranch, taskBranch);
  assert.equal("stdoutBytes" in proof, false);
  assert.equal("PSComputerName" in proof, false);
  assert.equal("RunspaceId" in proof, false);
  assert.equal("PSShowComputerName" in proof, false);
});

test("the real host recovery wrapper emits a structured refusal with a nonzero exit", (t) => {
  const refusal = {
    proofVersion: 1,
    proven: false,
    ready: false,
    code: "WORKSPACE_PRESERVATION_AMBIGUOUS",
    phase: "preservation-discovery",
    reason: "WORKSPACE_PRESERVATION_AMBIGUOUS",
    message: "Multiple preservation candidates matched.",
    refusal: {
      phase: "preservation-discovery",
      reason: "WORKSPACE_PRESERVATION_AMBIGUOUS",
      code: "WORKSPACE_PRESERVATION_AMBIGUOUS",
      message: "Multiple preservation candidates matched.",
    },
    taskBranch,
    taskBranchCreated: false,
    currentBranch: "main",
  };

  const completed = runRecoveryHostWrapper(t, refusal);

  assert.notEqual(completed.status, 0, completed.stderr);
  const result = JSON.parse(completed.stdout.trim());
  assert.equal(result.proven, false);
  assert.equal(result.refusal.phase, "preservation-discovery");
  assert.equal(result.refusal.reason, "WORKSPACE_PRESERVATION_AMBIGUOUS");
  assert.equal(result.taskBranchCreated, false);
  assert.match(completed.stderr, /RELAY_WORKSPACE_REFUSED:/u);
});

test("the real host recovery wrapper emits a structured exceptional result", (t) => {
  const completed = runRecoveryHostWrapper(t, null, { throwGuest: true });

  assert.equal(completed.status, 1);
  const result = JSON.parse(completed.stdout.trim());
  assert.equal(result.proven, false);
  assert.equal(result.code, "RECOVERY_HOST_EXCEPTION");
  assert.equal(result.phase, "host-wrapper");
  assert.equal(result.reason, "RECOVERY_HOST_EXCEPTION");
  assert.match(result.message, /guest exception/u);
  assert.match(completed.stderr, /RELAY_RECOVERY_FAILED:/u);
});

test("a preservation ref created before receipt interruption is validated and reused without duplication", (t) => {
  const repository = createRepository(t);
  const project = clone(repository, "guest-partial-preservation");
  const untrackedPath = "baloot_client/Assets/中断 恢复/Automation.meta";
  write(path.join(project, ...untrackedPath.split("/")), "partial\n");
  const originalHead = git(project, "rev-parse", "HEAD");
  const inspection = inspect(project);
  const alternateIndex = path.join(repository.root, "partial-preserve.index");
  const indexEnvironment = { GIT_INDEX_FILE: alternateIndex };
  gitWithEnvironment(project, indexEnvironment, "read-tree", originalHead);
  gitWithEnvironment(project, indexEnvironment, "add", "--all");
  const tree = gitWithEnvironment(project, indexEnvironment, "write-tree");
  const partialCommit = git(
    project,
    "-c",
    "user.name=Relay Test",
    "-c",
    "user.email=relay@test.invalid",
    "commit-tree",
    tree,
    "-p",
    originalHead,
    "-m",
    `chore(relay): preserve workspace before ${taskBranch}`,
    "-m",
    `Relay-Audit-Fingerprint: ${inspection.audit.fingerprint}`,
  );
  const partialBranch =
    "relay/preserved/task-0017-task-20260727T000000000Z-partial000001";
  git(
    project,
    "update-ref",
    `refs/heads/${partialBranch}`,
    partialCommit,
    "0".repeat(40),
  );

  const result = prepare(
    project,
    repository,
    taskBranch,
    "recovery",
    inspection.audit,
  );

  assert.equal(result.reusedPreservation, true);
  assert.equal(result.reused, true);
  assert.equal(result.preservedBranch, partialBranch);
  assert.equal(result.preservedCommit, partialCommit);
  assert.deepEqual(
    refs(project, "refs/heads/relay/preserved/task-0017-task-*"),
    [`refs/heads/${partialBranch}`],
  );
  assert.equal(
    result.preservedFiles[0].preservedBlob,
    inspection.audit.changes[0].auditBlob,
  );
});

test("one invalid legacy preservation ref is retained while recovery creates a verified replacement", (t) => {
  const repository = createRepository(t);
  const project = clone(repository, "guest-invalid-partial");
  const untrackedPath = "baloot_client/Assets/失败 验证/Automation.meta";
  write(path.join(project, ...untrackedPath.split("/")), "ambiguous\n");
  const originalHead = git(project, "rev-parse", "HEAD");
  const inspection = inspect(project);
  const invalidBranch =
    "relay/preserved/task-0017-task-20260727T000000000Z-invalid000001";
  git(
    project,
    "update-ref",
    `refs/heads/${invalidBranch}`,
    originalHead,
    "0".repeat(40),
  );

  const result = prepare(
    project,
    repository,
    taskBranch,
    "recovery",
    inspection.audit,
  );

  assert.equal(result.ready, true);
  assert.equal(result.proven, true);
  assert.equal(result.reusedPreservation, false);
  assert.equal(result.preservationVerified, true);
  assert.equal(result.taskBranchCreated, true);
  assert.equal(result.currentBranch, taskBranch);
  assert.notEqual(result.preservedBranch, invalidBranch);
  assert.equal(result.preservationParent, originalHead);
  assert.equal(
    result.preservedFiles[0].preservedBlob,
    inspection.audit.changes[0].auditBlob,
  );
  assert.equal(
    git(project, "rev-parse", `refs/heads/${invalidBranch}`),
    originalHead,
  );
  const preservationRefs = refs(
    project,
    "refs/heads/relay/preserved/task-0017-task-*",
  );
  assert.equal(preservationRefs.length, 2);
  assert.equal(preservationRefs.includes(`refs/heads/${invalidBranch}`), true);
  assert.equal(
    preservationRefs.includes(`refs/heads/${result.preservedBranch}`),
    true,
  );
  assert.equal(git(project, "status", "--porcelain=v1"), "");
  assert.doesNotMatch(JSON.stringify(result), /unexpected: \./u);
});

test("recovery preserves sparse baseline entries while adding only audited paths", (t) => {
  const repository = createRepository(t);
  const project = clone(repository, "guest-sparse-baseline");
  const sparseBaselinePath = "baloot_client/Assets/Tournament/Tracked.asset";
  const untrackedPath =
    "baloot_client/Assets/AppAssets/hall/scripts/Common/Automation.meta";
  const sparseBaselineFile = path.join(
    project,
    ...sparseBaselinePath.split("/"),
  );
  write(
    path.join(project, ...untrackedPath.split("/")),
    "fileFormatVersion: 2\nguid: sparse-preservation\n",
  );
  git(project, "update-index", "--skip-worktree", "--", sparseBaselinePath);
  fs.unlinkSync(sparseBaselineFile);

  const inspection = inspect(project);
  assert.deepEqual(
    inspection.audit.changes.map(({ code, path: auditedPath }) => [
      code,
      auditedPath,
    ]),
    [["??", untrackedPath]],
  );

  const result = prepare(
    project,
    repository,
    taskBranch,
    "recovery",
    inspection.audit,
  );

  assert.equal(result.ready, true);
  assert.equal(result.proven, true);
  assert.deepEqual(
    result.preservedNameStatus.map(({ status, path: changedPath }) => [
      status[0],
      changedPath,
    ]),
    [["A", untrackedPath]],
  );
  assert.equal(
    git(
      project,
      "cat-file",
      "-e",
      `${result.preservedCommit}:${sparseBaselinePath}`,
    ),
    "",
  );
});

test("multiple invalid legacy preservation refs remain ambiguous and unchanged", (t) => {
  const repository = createRepository(t);
  const project = clone(repository, "guest-multiple-invalid-partials");
  const untrackedPath = "baloot_client/Assets/多个 旧引用/Automation.meta";
  write(path.join(project, ...untrackedPath.split("/")), "ambiguous\n");
  const originalHead = git(project, "rev-parse", "HEAD");
  const originalStatus = git(project, "status", "--porcelain=v1");
  const inspection = inspect(project);
  const invalidBranches = [
    "relay/preserved/task-0017-task-20260727T000000000Z-invalid000001",
    "relay/preserved/task-0017-task-20260727T000000001Z-invalid000002",
  ];
  for (const branch of invalidBranches) {
    git(
      project,
      "update-ref",
      `refs/heads/${branch}`,
      originalHead,
      "0".repeat(40),
    );
  }

  const result = prepare(
    project,
    repository,
    taskBranch,
    "recovery",
    inspection.audit,
  );

  assert.equal(result.ready, false);
  assert.equal(result.proven, false);
  assert.equal(result.refusal.phase, "preservation-discovery");
  assert.equal(result.refusal.reason, "WORKSPACE_PRESERVATION_AMBIGUOUS");
  assert.equal(git(project, "branch", "--show-current"), "main");
  assert.equal(git(project, "rev-parse", "HEAD"), originalHead);
  assert.equal(git(project, "status", "--porcelain=v1"), originalStatus);
  assert.equal(refs(project, `refs/heads/${taskBranch}`).length, 0);
  assert.deepEqual(
    refs(project, "refs/heads/relay/preserved/task-0017-task-*"),
    invalidBranches.map((branch) => `refs/heads/${branch}`),
  );
});

test("a tracked deletion stops without checkout, preservation, or status changes", (t) => {
  const repository = createRepository(t);
  const project = clone(repository, "guest-deletion");
  const deletedPath = "baloot_client/Assets/Tournament/Tracked.asset";
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
