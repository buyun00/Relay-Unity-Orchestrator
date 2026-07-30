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
const inspectHostScript = path.resolve(
  "scripts/hyperv/Inspect-PreservedWorkspace.ps1",
);
const verifyHostScript = path.resolve(
  "scripts/hyperv/Verify-PreservedWorkspace.ps1",
);
const recoverHostScript = path.resolve("scripts/hyperv/Recover-Workspace.ps1");
const recoverGuestScript = path.resolve(
  "scripts/hyperv/Recover-Workspace.Guest.ps1",
);
const workspaceGitScript = path.resolve("scripts/hyperv/Workspace-Git.ps1");
const powerShellDirectScript = path.resolve(
  "scripts/hyperv/PowerShell-Direct.ps1",
);
const taskBranch = "codex/task-0017-task";
const recoveryTaskBranch = "codex/task-0019-hall-3-empty-top-left-gifts-grid";

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

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runHostWorkspaceScript(
  t,
  hostScript,
  project,
  parameters,
  expectedArgumentCount,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-host-guest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credentialPath = path.join(root, "credential.xml");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    `$credential = New-Object System.Management.Automation.PSCredential('relay-test', (ConvertTo-SecureString 'test' -AsPlainText -Force))`,
    `$credential | Export-Clixml -LiteralPath ${powershellQuote(credentialPath)}`,
    `function global:Invoke-Command {
      param(
        [string]$VMName,
        [pscredential]$Credential,
        [object[]]$ArgumentList,
        [scriptblock]$ScriptBlock,
        [switch]$AsJob
      )
      if ($ArgumentList.Count -ne ${expectedArgumentCount}) {
        throw "Expected ${expectedArgumentCount} PowerShell Direct arguments, received $($ArgumentList.Count)."
      }
      & $ScriptBlock @ArgumentList
    }`,
    `& ${powershellQuote(hostScript)} -VMName 'fake-vm' -CredentialPath ${powershellQuote(
      credentialPath,
    )} -GuestProjectPath ${powershellQuote(project)} ${parameters}`,
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(
    result.status,
    0,
    `PowerShell host/guest regression failed:\n${result.stderr}\n${result.stdout}`,
  );
  return JSON.parse(result.stdout.trim());
}

function inspectThroughHost(t, project) {
  return runHostWorkspaceScript(t, inspectHostScript, project, "", 3);
}

function verifyThroughHost(t, project, auditedFiles) {
  const head = git(project, "rev-parse", "HEAD");
  return runHostWorkspaceScript(
    t,
    verifyHostScript,
    project,
    [
      `-TaskBranch ${powershellQuote(taskBranch)}`,
      `-ExpectedHead ${powershellQuote(head)}`,
      `-AuditedFilesJson ${powershellQuote(JSON.stringify(auditedFiles))}`,
    ].join(" "),
    6,
  );
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
  const expectedTip = "d".repeat(40);
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
        [scriptblock]$ScriptBlock,
        [switch]$AsJob
      )
      $global:relayInvokeCount += 1
      if ($global:relayInvokeCount -eq 1) {
        if (${throwGuest ? "$true" : "$false"}) {
          throw '模拟 guest exception'
        }
        return $global:relayGuestJson
      }
      return $true
    }`,
    `& ${quote(recoverHostScript)} -VMName 'fake-vm' -CredentialPath ${quote(
      credentialPath,
    )} -GuestProjectPath 'D:\\Work\\中文 Project' -RepoUrl 'https://example.test/repo.git' -BaseBranch 'main' -TaskBranch ${quote(
      taskBranch,
    )} -ExpectedRemoteTip '${expectedTip}' -PowerShellDirectTimeoutSeconds 60`,
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      windowsHide: true,
    },
  );
}

function publishRecoveryTip(repository, branch = recoveryTaskBranch) {
  const seed = path.join(repository.root, "seed");
  git(seed, "checkout", "-q", "-b", branch);
  write(path.join(seed, "remote-task", "delivered.txt"), "durably delivered\n");
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
    "durable task delivery",
  );
  const tip = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "-q", "-u", "origin", branch);
  git(seed, "checkout", "-q", "main");
  return tip;
}

function recoverClean(
  project,
  repository,
  expectedRemoteTip,
  branch = recoveryTaskBranch,
) {
  const completed = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      recoverGuestScript,
      "-ProjectPath",
      project,
      "-RepositoryUrl",
      repository.remote,
      "-BaseBranch",
      "main",
      "-TaskBranch",
      branch,
      "-ExpectedRemoteTip",
      expectedRemoteTip,
      "-GitNetworkTimeoutSeconds",
      "30",
      "-OutputJson",
    ],
    { cwd: path.resolve("."), encoding: "utf8", windowsHide: true },
  );
  assert.equal(
    completed.status,
    0,
    "Clean recovery guest failed:\n" +
      completed.stderr +
      "\n" +
      completed.stdout,
  );
  return JSON.parse(completed.stdout.trim());
}

function runPowerShellJson(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const completed = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ],
    { cwd: path.resolve("."), encoding: "utf8", windowsHide: true },
  );
  assert.equal(
    completed.status,
    0,
    "PowerShell behavior regression failed:\n" +
      completed.stderr +
      "\n" +
      completed.stdout,
  );
  return JSON.parse(completed.stdout.trim());
}

test("a clean established workspace produces an empty coherent audit", (t) => {
  const repository = createRepository(t);
  const project = clone(repository, "guest-clean-inspection");

  const inspection = inspect(project);

  assert.equal(inspection.ready, true);
  assert.equal(inspection.repositoryExists, true);
  assert.deepEqual(inspection.statusBefore, []);
  assert.deepEqual(inspection.auditedFiles, []);
  assert.deepEqual(inspection.audit.changes, []);
  assert.match(inspection.audit.fingerprint, /^[0-9a-f]{64}$/u);
});

test("real host/guest verification normalizes empty and null audits into one PowerShell Direct parameter", (t) => {
  const repository = createRepository(t);
  const project = clone(repository, "guest-clean-task-branch");
  const prepared = prepare(project, repository);
  assert.equal(prepared.ready, true);
  assert.equal(prepared.branch, taskBranch);
  const branchBefore = git(project, "branch", "--show-current");
  const headBefore = git(project, "rev-parse", "HEAD");
  const preservationRefsBefore = refs(project, "refs/heads/relay/preserved/");

  for (const auditedFiles of [[], null]) {
    const result = verifyThroughHost(t, project, auditedFiles);
    assert.equal(result.ready, true);
    assert.equal(result.preserved, true);
    assert.equal(result.branch, taskBranch);
    assert.equal(result.head, headBefore);
    assert.equal(result.changedFiles, 0);
    assert.deepEqual(result.status, []);
    assert.deepEqual(result.auditedFiles, []);
    assert.equal(result.transport.auditedFilesParameters, 1);
    assert.equal(result.transport.auditedFilesCount, 0);
  }

  const inspection = inspectThroughHost(t, project);
  assert.equal(inspection.ready, true);
  assert.deepEqual(inspection.auditedFiles, []);
  assert.deepEqual(inspection.audit.changes, []);
  assert.equal(inspection.transport.auditedFilesCount, 0);
  assert.equal(git(project, "branch", "--show-current"), branchBefore);
  assert.equal(git(project, "rev-parse", "HEAD"), headBefore);
  assert.deepEqual(
    refs(project, "refs/heads/relay/preserved/"),
    preservationRefsBefore,
  );
});

test("real host/guest verification accepts one or many unchanged audited files without mutation", (t) => {
  for (const count of [1, 2]) {
    const repository = createRepository(t);
    const project = clone(repository, `guest-dirty-task-branch-${count}`);
    const prepared = prepare(project, repository);
    assert.equal(prepared.ready, true);
    for (let index = 0; index < count; index += 1) {
      write(
        path.join(
          project,
          "baloot_client",
          "Assets",
          "Incident",
          `dirty-${index}.meta`,
        ),
        `fileFormatVersion: 2\nguid: dirty-${count}-${index}\n`,
      );
    }
    const branchBefore = git(project, "branch", "--show-current");
    const headBefore = git(project, "rev-parse", "HEAD");
    const statusBefore = gitNulFields(
      project,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    );
    const preservationRefsBefore = refs(project, "refs/heads/relay/preserved/");
    const inspection = inspectThroughHost(t, project);
    assert.equal(inspection.auditedFiles.length, count);

    const result = verifyThroughHost(t, project, inspection.auditedFiles);

    assert.equal(result.ready, true);
    assert.equal(result.preserved, true);
    assert.equal(result.code, null);
    assert.equal(result.branch, taskBranch);
    assert.equal(result.head, headBefore);
    assert.equal(result.changedFiles, count);
    assert.equal(result.auditedFiles.length, count);
    assert.equal(result.auditMatched, true);
    assert.equal(result.auditFingerprint, inspection.audit.fingerprint);
    assert.equal(result.expectedAuditFingerprint, inspection.audit.fingerprint);
    assert.equal(result.transport.auditedFilesParameters, 1);
    assert.equal(result.transport.auditedFilesCount, count);
    assert.equal(git(project, "branch", "--show-current"), branchBefore);
    assert.equal(git(project, "rev-parse", "HEAD"), headBefore);
    assert.deepEqual(
      gitNulFields(
        project,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ),
      statusBefore,
    );
    assert.deepEqual(
      refs(project, "refs/heads/relay/preserved/"),
      preservationRefsBefore,
    );
  }
});

test("real host/guest verification refuses workspace content changed after inspection", (t) => {
  const repository = createRepository(t);
  const project = clone(repository, "guest-dirty-changed-after-audit");
  const prepared = prepare(project, repository);
  assert.equal(prepared.ready, true);
  const dirtyPath = path.join(
    project,
    "baloot_client",
    "Assets",
    "Incident",
    "dirty-after-audit.meta",
  );
  write(dirtyPath, "fileFormatVersion: 2\nguid: before-audit\n");
  const inspection = inspectThroughHost(t, project);
  write(dirtyPath, "fileFormatVersion: 2\nguid: after-audit\n");

  const result = verifyThroughHost(t, project, inspection.auditedFiles);

  assert.equal(result.ready, false);
  assert.equal(result.preserved, true);
  assert.equal(result.code, "PRESERVED_WORKSPACE_CHANGED_AFTER_INSPECTION");
  assert.equal(result.auditMatched, false);
  assert.notEqual(result.auditFingerprint, result.expectedAuditFingerprint);
  assert.equal(
    fs.readFileSync(dirtyPath, "utf8"),
    "fileFormatVersion: 2\nguid: after-audit\n",
  );
});

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
    [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ],
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
  assert.equal(result.phase, "recovery-host-wrapper");
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
  const hiddenModifiedPath = "baloot_client/Packages/manifest.json";
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
  git(project, "update-index", "--skip-worktree", "--", hiddenModifiedPath);
  write(
    path.join(project, ...hiddenModifiedPath.split("/")),
    '{"base":2,"hidden-by-skip-worktree":true}\n',
  );
  git(project, "update-index", "--skip-worktree", "--", sparseBaselinePath);
  fs.unlinkSync(sparseBaselineFile);

  const inspection = inspect(project);
  assert.deepEqual(
    inspection.audit.changes
      .map(({ code, path: auditedPath }) => [code, auditedPath])
      .sort((left, right) => left[1].localeCompare(right[1])),
    [
      ["??", untrackedPath],
      [" M", hiddenModifiedPath],
    ].sort((left, right) => left[1].localeCompare(right[1])),
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
    result.preservedNameStatus
      .map(({ status, path: changedPath }) => [status[0], changedPath])
      .sort((left, right) => left[1].localeCompare(right[1])),
    [
      ["A", untrackedPath],
      ["M", hiddenModifiedPath],
    ].sort((left, right) => left[1].localeCompare(right[1])),
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

test("recovery continues from its current preservation checkpoint without rewriting older refs", (t) => {
  const repository = createRepository(t);
  const project = clone(repository, "guest-preservation-checkpoint");
  const untrackedPath =
    "baloot_client/Assets/AppAssets/hall/scripts/Common/Automation.meta";
  const hiddenModifiedPath = "baloot_client/Packages/manifest.json";
  write(
    path.join(project, ...untrackedPath.split("/")),
    "fileFormatVersion: 2\nguid: checkpoint-preservation\n",
  );
  const originalHead = git(project, "rev-parse", "HEAD");
  const firstInspection = inspect(project);
  const alternateIndex = path.join(
    repository.root,
    "checkpoint-preserve.index",
  );
  const indexEnvironment = { GIT_INDEX_FILE: alternateIndex };
  gitWithEnvironment(project, indexEnvironment, "read-tree", originalHead);
  gitWithEnvironment(
    project,
    indexEnvironment,
    "add",
    "--all",
    "--",
    untrackedPath,
  );
  const checkpointTree = gitWithEnvironment(
    project,
    indexEnvironment,
    "write-tree",
  );
  const checkpointCommit = git(
    project,
    "-c",
    "user.name=Relay Test",
    "-c",
    "user.email=relay@test.invalid",
    "commit-tree",
    checkpointTree,
    "-p",
    originalHead,
    "-m",
    `chore(relay): preserve workspace before ${taskBranch}`,
    "-m",
    `Relay-Audit-Fingerprint: ${firstInspection.audit.fingerprint}`,
  );
  const legacyBranch =
    "relay/preserved/task-0017-task-20260727T000000000Z-legacy000001";
  const checkpointBranch =
    "relay/preserved/task-0017-task-20260727T000000001Z-checkpoint001";
  git(
    project,
    "update-ref",
    `refs/heads/${legacyBranch}`,
    originalHead,
    "0".repeat(40),
  );
  git(
    project,
    "update-ref",
    `refs/heads/${checkpointBranch}`,
    checkpointCommit,
    "0".repeat(40),
  );
  git(project, "read-tree", checkpointCommit);
  git(project, "checkout", checkpointBranch);
  git(project, "update-index", "--skip-worktree", "--", hiddenModifiedPath);
  write(
    path.join(project, ...hiddenModifiedPath.split("/")),
    '{"base":2,"checkpoint-hidden-change":true}\n',
  );

  const secondInspection = inspect(project);
  assert.deepEqual(
    secondInspection.audit.changes.map(({ code, path: auditedPath }) => [
      code,
      auditedPath,
    ]),
    [[" M", hiddenModifiedPath]],
  );

  const result = prepare(
    project,
    repository,
    taskBranch,
    "recovery",
    secondInspection.audit,
  );

  assert.equal(result.ready, true);
  assert.equal(result.proven, true);
  assert.equal(result.preservationParent, checkpointCommit);
  assert.notEqual(result.preservedBranch, checkpointBranch);
  assert.equal(
    git(project, "rev-parse", `refs/heads/${legacyBranch}`),
    originalHead,
  );
  assert.equal(
    git(project, "rev-parse", `refs/heads/${checkpointBranch}`),
    checkpointCommit,
  );
  assert.equal(
    git(
      project,
      "cat-file",
      "-e",
      `${result.preservedCommit}:${untrackedPath}`,
    ),
    "",
  );
  assert.equal(git(project, "branch", "--show-current"), taskBranch);
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

test("clean main recovery verifies the exact remote tip and creates a tracking branch", (t) => {
  const repository = createRepository(t);
  const remoteTip = publishRecoveryTip(repository);
  const project = clone(repository, "clean-main-recovery");
  const mainHead = git(project, "rev-parse", "refs/heads/main");
  const refsBefore = refs(project, "refs/heads/relay/preserved/");
  const globalBefore = spawnSync(
    "git",
    ["config", "--global", "--list", "--show-origin"],
    { encoding: "utf8", windowsHide: true },
  ).stdout;

  const result = recoverClean(project, repository, remoteTip);

  assert.equal(result.ready, true, JSON.stringify(result, null, 2));
  assert.equal(result.proofVersion, 2);
  assert.equal(result.expectedRemoteTip, remoteTip);
  assert.equal(result.remoteTip, remoteTip);
  assert.equal(result.remoteRef, "refs/heads/" + recoveryTaskBranch);
  assert.equal(result.branchAction, "created");
  assert.equal(result.taskBranchCreated, true);
  assert.equal(result.preservationRefCreated, false);
  assert.deepEqual(result.statusBefore, []);
  assert.deepEqual(result.untrackedFilesBefore, []);
  assert.deepEqual(result.statusAfter, []);
  assert.deepEqual(result.untrackedFilesAfter, []);
  assert.equal(git(project, "branch", "--show-current"), recoveryTaskBranch);
  assert.equal(git(project, "rev-parse", "HEAD"), remoteTip);
  assert.equal(
    git(
      project,
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ),
    "origin/" + recoveryTaskBranch,
  );
  assert.equal(git(project, "rev-parse", "refs/heads/main"), mainHead);
  assert.deepEqual(refs(project, "refs/heads/relay/preserved/"), refsBefore);
  assert.equal(
    spawnSync("git", ["config", "--global", "--list", "--show-origin"], {
      encoding: "utf8",
      windowsHide: true,
    }).stdout,
    globalBefore,
  );
});

test("an existing compatible local task branch is reused without overwrite", (t) => {
  const repository = createRepository(t);
  const remoteTip = publishRecoveryTip(repository);
  const project = clone(repository, "existing-compatible-recovery");
  git(project, "branch", recoveryTaskBranch, remoteTip);
  const refsBefore = refs(project, "refs/heads/");

  const result = recoverClean(project, repository, remoteTip);

  assert.equal(result.ready, true, JSON.stringify(result, null, 2));
  assert.equal(result.branchAction, "existing-compatible");
  assert.equal(result.taskBranchCreated, false);
  assert.equal(result.taskBranchFastForwarded, false);
  assert.equal(result.localTaskHeadBefore, remoteTip);
  assert.equal(result.localTaskHeadAfter, remoteTip);
  assert.equal(git(project, "rev-parse", "HEAD"), remoteTip);
  assert.deepEqual(refs(project, "refs/heads/relay/preserved/"), []);
  assert.ok(refs(project, "refs/heads/").length >= refsBefore.length);
});

test("dirty recovery is refused before remote or branch mutation", (t) => {
  const repository = createRepository(t);
  const remoteTip = publishRecoveryTip(repository);
  const project = clone(repository, "dirty-recovery-refusal");
  const dirtyPath = path.join(project, "incident-untracked.txt");
  write(dirtyPath, "preserve me\n");
  const branchBefore = git(project, "branch", "--show-current");
  const headBefore = git(project, "rev-parse", "HEAD");
  const refsBefore = refs(project, "refs/heads/");

  const result = recoverClean(project, repository, remoteTip);

  assert.equal(result.ready, false);
  assert.equal(result.code, "WORKSPACE_DIRTY_REFUSED");
  assert.equal(result.phase, "workspace-cleanliness");
  assert.ok(result.untrackedFilesBefore.includes("incident-untracked.txt"));
  assert.equal(git(project, "branch", "--show-current"), branchBefore);
  assert.equal(git(project, "rev-parse", "HEAD"), headBefore);
  assert.deepEqual(refs(project, "refs/heads/"), refsBefore);
  assert.equal(fs.readFileSync(dirtyPath, "utf8"), "preserve me\n");
});

test("remote tip mismatch refuses before fetch and local branch creation", (t) => {
  const repository = createRepository(t);
  publishRecoveryTip(repository);
  const project = clone(repository, "remote-tip-mismatch");
  const headBefore = git(project, "rev-parse", "HEAD");
  const localRefsBefore = refs(project, "refs/heads/");

  const result = recoverClean(project, repository, "f".repeat(40));

  assert.equal(result.ready, false);
  assert.equal(result.code, "RECOVERY_REMOTE_TIP_MISMATCH");
  assert.equal(result.phase, "remote-tip-verification");
  assert.equal(result.expectedRemoteTip, "f".repeat(40));
  assert.notEqual(result.remoteTip, result.expectedRemoteTip);
  assert.equal(git(project, "branch", "--show-current"), "main");
  assert.equal(git(project, "rev-parse", "HEAD"), headBefore);
  assert.deepEqual(refs(project, "refs/heads/"), localRefsBefore);
});

test("a non-fast-forward local task branch is refused without switching main", (t) => {
  const repository = createRepository(t);
  const remoteTip = publishRecoveryTip(repository);
  const project = clone(repository, "non-fast-forward-refusal");
  git(project, "checkout", "-q", "-b", recoveryTaskBranch, "main");
  write(path.join(project, "local-only.txt"), "local divergent commit\n");
  git(project, "add", ".");
  git(
    project,
    "-c",
    "user.name=Relay Test",
    "-c",
    "user.email=relay@test.invalid",
    "commit",
    "-q",
    "-m",
    "local divergent task",
  );
  const localTaskHead = git(project, "rev-parse", "HEAD");
  git(project, "checkout", "-q", "main");
  const mainHead = git(project, "rev-parse", "HEAD");

  const result = recoverClean(project, repository, remoteTip);

  assert.equal(result.ready, false);
  assert.equal(result.code, "WORKSPACE_TARGET_BRANCH_NON_FAST_FORWARD");
  assert.equal(result.phase, "local-task-compatibility");
  assert.equal(git(project, "branch", "--show-current"), "main");
  assert.equal(git(project, "rev-parse", "HEAD"), mainHead);
  assert.equal(git(project, "rev-parse", recoveryTaskBranch), localTaskHead);
});

test("curl 18 is retried once with bounded backoff and then succeeds", () => {
  const helper = workspaceGitScript.replaceAll("'", "''");
  const result = runPowerShellJson(
    [
      "$ProgressPreference = 'SilentlyContinue'",
      ". '" + helper + "'",
      "$script:waits = New-Object System.Collections.Generic.List[int]",
      "$runner = { param($Repo,$Args,$Env,$Timeout,$Stage,$Attempt) if ($Attempt -eq 1) { [pscustomobject]@{ exitCode=1; stdoutBytes=[byte[]]@(); stdout=''; stderr='curl 18 transfer closed with outstanding read data'; stage=$Stage; timedOut=$false; timeoutSeconds=$Timeout; durationMs=5 } } else { [pscustomobject]@{ exitCode=0; stdoutBytes=[byte[]]@(); stdout='ok'; stderr=''; stage=$Stage; timedOut=$false; timeoutSeconds=$Timeout; durationMs=4 } } }",
      "$waiter = { param($Milliseconds,$Attempt) $script:waits.Add([int]$Milliseconds) }",
      "$value = Invoke-RelayGitWithRetry -RepositoryPath '.' -Arguments @('fetch') -Stage 'task-branch-fetch' -TimeoutSeconds 30 -MaximumAttempts 3 -InitialBackoffMilliseconds 1000 -ProcessInvoker $runner -BackoffWaiter $waiter",
      "[pscustomobject]@{ attempts=@($value.attempts); waits=@($script:waits) } | ConvertTo-Json -Depth 8 -Compress",
    ].join("; "),
  );
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].transient, true);
  assert.equal(result.attempts[0].backoffMilliseconds, 1000);
  assert.equal(result.attempts[1].exitCode, 0);
  assert.deepEqual(result.waits, [1000]);
});

test("three exhausted transient failures retain every attempt and backoff", () => {
  const helper = workspaceGitScript.replaceAll("'", "''");
  const result = runPowerShellJson(
    [
      "$ProgressPreference = 'SilentlyContinue'",
      ". '" + helper + "'",
      "$script:waits = New-Object System.Collections.Generic.List[int]",
      "$runner = { param($Repo,$Args,$Env,$Timeout,$Stage,$Attempt) [pscustomobject]@{ exitCode=1; stdoutBytes=[byte[]]@(); stdout=''; stderr='fatal: early EOF'; stage=$Stage; timedOut=$false; timeoutSeconds=$Timeout; durationMs=5 } }",
      "$waiter = { param($Milliseconds,$Attempt) $script:waits.Add([int]$Milliseconds) }",
      "try { Invoke-RelayGitWithRetry -RepositoryPath '.' -Arguments @('fetch') -Stage 'task-branch-fetch' -TimeoutSeconds 30 -MaximumAttempts 3 -InitialBackoffMilliseconds 1000 -ProcessInvoker $runner -BackoffWaiter $waiter | Out-Null; throw 'expected retry failure' } catch { [pscustomobject]@{ message=$_.Exception.Message; stage=$_.Exception.Data['relayStage']; attempts=@($_.Exception.Data['relayAttempts']); waits=@($script:waits) } | ConvertTo-Json -Depth 8 -Compress }",
    ].join("; "),
  );
  assert.equal(result.stage, "task-branch-fetch");
  assert.match(result.message, /early EOF/u);
  assert.equal(result.attempts.length, 3);
  assert.deepEqual(result.waits, [1000, 2000]);
  assert.equal(
    result.attempts.every((attempt) => attempt.transient),
    true,
  );
});

test("PowerShell Direct timeout stops only its owned job and reports the exact stage", () => {
  const helper = powerShellDirectScript.replaceAll("'", "''");
  const result = runPowerShellJson(
    [
      "$ProgressPreference = 'SilentlyContinue'",
      ". '" + helper + "'",
      "function global:Invoke-Command { param([string]$VMName,[pscredential]$Credential,[object[]]$ArgumentList,[scriptblock]$ScriptBlock,[switch]$AsJob) $global:ownedJob = Start-Job -ScriptBlock { Start-Sleep -Seconds 30 }; return $global:ownedJob }",
      "$credential = New-Object System.Management.Automation.PSCredential('test',(ConvertTo-SecureString 'test' -AsPlainText -Force))",
      "$started = [DateTime]::UtcNow",
      "try { Invoke-RelayPowerShellDirect -VMName 'fake' -Credential $credential -ArgumentList @('owned') -ScriptBlock {} -Stage 'powershell-direct-recovery' -TimeoutSeconds 1 | Out-Null; throw 'expected timeout' } catch { [pscustomobject]@{ message=$_.Exception.Message; stage=$_.Exception.Data['relayStage']; timedOut=$_.Exception.Data['relayTimedOut']; elapsedMs=[int]([DateTime]::UtcNow-$started).TotalMilliseconds; ownedJobRemoved=$null -eq (Get-Job -Id $global:ownedJob.Id -ErrorAction SilentlyContinue) } | ConvertTo-Json -Compress }",
    ].join("; "),
  );
  assert.equal(result.stage, "powershell-direct-recovery");
  assert.equal(result.timedOut, true);
  assert.match(result.message, /owned remoting job was stopped/u);
  assert.ok(result.elapsedMs < 10_000);
  assert.equal(result.ownedJobRemoved, true);
});

test("recovery source suppresses prompts and forbids deletion or global Git mutation", () => {
  const gitSource = fs.readFileSync(workspaceGitScript, "utf8");
  const recoverySource = fs.readFileSync(recoverGuestScript, "utf8");
  const hostSource = fs.readFileSync(recoverHostScript, "utf8");
  const directSource = fs.readFileSync(powerShellDirectScript, "utf8");
  const chain = [gitSource, recoverySource, hostSource, directSource].join(
    "\n",
  );

  assert.match(gitSource, /http\.version=HTTP\/1\.1/u);
  assert.match(gitSource, /credential\.interactive=never/u);
  assert.match(gitSource, /GIT_TERMINAL_PROMPT.*0/u);
  assert.match(gitSource, /GCM_INTERACTIVE.*Never/u);
  assert.match(gitSource, /WaitForExit\(\$TimeoutSeconds \* 1000\)/u);
  assert.match(gitSource, /\$process\.Kill\(\)/u);
  assert.match(recoverySource, /ls-remote.*--exit-code.*--refs/su);
  assert.match(recoverySource, /fetch.*--no-tags.*--no-prune/su);
  assert.match(
    recoverySource,
    /refs\/heads\/\$\(\$TaskBranch\):refs\/remotes\/origin\/\$TaskBranch/u,
  );
  assert.match(directSource, /Stop-Job -Job \$job/u);
  assert.doesNotMatch(chain, /\bgit\s+config\s+--global\b/iu);
  assert.doesNotMatch(chain, /(?:'|")(?:reset|clean|restore|rebase)(?:'|")/u);
  assert.doesNotMatch(chain, /\bRemove-Item\b/u);
  assert.doesNotMatch(chain, /\b(?:taskkill|Stop-Process)\b/iu);
});
