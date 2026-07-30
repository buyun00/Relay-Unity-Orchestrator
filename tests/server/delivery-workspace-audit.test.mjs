import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const powershell =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const git = "C:\\Program Files\\Git\\cmd\\git.exe";
const auditScript = new URL(
  "../../scripts/hyperv/Get-DeliveryWorkspaceAudit.Guest.ps1",
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]:)/u, "$1");

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

async function createRepository(t) {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-delivery-audit-"),
  );
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  await run(git, ["init", "-b", "codex/task-exact-audit", repository]);
  await run(git, ["-C", repository, "config", "user.name", "Relay Test"]);
  await run(git, [
    "-C",
    repository,
    "config",
    "user.email",
    "relay-test@localhost",
  ]);
  fs.mkdirSync(path.join(repository, "Assets"), { recursive: true });
  fs.writeFileSync(path.join(repository, "Assets", "Only.cs"), "baseline\n");
  await run(git, ["-C", repository, "add", "--", "Assets/Only.cs"]);
  await run(git, ["-C", repository, "commit", "-m", "baseline"]);
  fs.writeFileSync(path.join(repository, "Assets", "Only.cs"), "intended\n");
  const head = (await run(git, ["-C", repository, "rev-parse", "HEAD"])).stdout
    .trim()
    .toLowerCase();
  return { repository, head };
}

async function invokeAudit({
  repository,
  expectedHead = null,
  changedFiles = ["Assets/Only.cs"],
  validation = ["PowerShell syntax passed", "targeted tests passed"],
  expectedAudit = null,
}) {
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    auditScript,
    "-ProjectPath",
    repository,
    "-ExpectedBranch",
    "codex/task-exact-audit",
    "-ChangedFilesJson",
    JSON.stringify(changedFiles),
    "-ValidationJson",
    JSON.stringify(validation),
    "-OutputJson",
  ];
  if (expectedHead) args.push("-ExpectedHead", expectedHead);
  if (expectedAudit)
    args.push("-ExpectedAuditJson", JSON.stringify(expectedAudit));
  const result = await run(powershell, args);
  return JSON.parse(result.stdout.trim());
}

test("delivery audit accepts the exact tracked file and rejects hash or extra-file drift without mutation", async (t) => {
  const { repository, head } = await createRepository(t);
  const recorded = await invokeAudit({ repository });

  assert.equal(recorded.ready, true);
  assert.equal(recorded.safeForDeliveryRetry, true);
  assert.equal(recorded.completeFileSet, true);
  assert.equal(recorded.branch, "codex/task-exact-audit");
  assert.equal(recorded.head, head);
  assert.deepEqual(recorded.changedFiles, ["Assets/Only.cs"]);
  assert.deepEqual(recorded.blockedPaths, []);
  assert.match(recorded.files[0].gitBlob, /^[0-9a-f]{40}$/u);
  assert.match(recorded.files[0].sha256, /^[0-9a-f]{64}$/u);
  const fingerprintPayload = [
    "relay-delivery-audit-v1",
    recorded.branch,
    recorded.head,
    recorded.changedFiles.join("\0"),
    recorded.validation.join("\0"),
    `${recorded.files[0].code}\0\0${recorded.files[0].path}\0${recorded.files[0].gitBlob}\0${recorded.files[0].sha256}`,
  ].join("\0");
  assert.equal(
    recorded.fingerprint,
    createHash("sha256").update(fingerprintPayload, "utf8").digest("hex"),
  );

  const exact = await invokeAudit({
    repository,
    expectedHead: head,
    expectedAudit: recorded,
  });
  assert.equal(exact.ready, true);
  assert.equal(exact.exact, true);
  assert.equal(exact.fingerprint, recorded.fingerprint);

  fs.writeFileSync(
    path.join(repository, "Assets", "Only.cs"),
    "unexpected drift\n",
  );
  const hashMismatch = await invokeAudit({
    repository,
    expectedHead: head,
    expectedAudit: recorded,
  });
  assert.equal(hashMismatch.ready, false);
  assert.equal(hashMismatch.code, "DELIVERY_RETRY_AUDIT_MISMATCH");

  fs.writeFileSync(path.join(repository, "Assets", "Only.cs"), "intended\n");
  fs.writeFileSync(path.join(repository, "Assets", "Extra.cs"), "extra\n");
  const extraFile = await invokeAudit({
    repository,
    expectedHead: head,
    expectedAudit: recorded,
  });
  assert.equal(extraFile.ready, false);
  assert.equal(extraFile.code, "DELIVERY_RETRY_AUDIT_MISMATCH");
  assert.ok(extraFile.blockedPaths.includes("Assets/Extra.cs"));
});
