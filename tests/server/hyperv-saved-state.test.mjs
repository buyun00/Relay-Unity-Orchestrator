import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("Hyper-V saved-state recovery preserves valid state and cold-starts only after resume failure", () => {
  const script = path.resolve("tests/powershell/Test-SavedStateRecovery.ps1");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
    },
  );

  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
  const output = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const evidence = JSON.parse(output);
  assert.deepEqual(evidence, {
    passed: 3,
    validSavedPreserved: true,
    invalidSavedRecovered: true,
    offColdStarted: true,
  });
});

test("worker graceful shutdown uses the host-compatible Stop-VM default parameter set", () => {
  const controlScript = fs.readFileSync(
    path.resolve("scripts/hyperv/Control-Worker.ps1"),
    "utf8",
  );
  assert.doesNotMatch(controlScript, /\bStop-VM\b[^\r\n]*\s-Shutdown\b/u);
  assert.match(
    controlScript,
    /\bStop-VM\s+-VM\s+\$vm\s+-Confirm:\$false\s+-ErrorAction\s+Stop/u,
  );
});

test("every VM start entry point uses the shared saved-state fallback", () => {
  for (const scriptPath of [
    "scripts/hyperv/Control-Worker.ps1",
    "scripts/hyperv/Ensure-WorkerReady.ps1",
    "scripts/hyperv/Restore-Worker.ps1",
  ]) {
    const script = fs.readFileSync(path.resolve(scriptPath), "utf8");
    assert.match(
      script,
      /Saved-State-Recovery\.ps1/u,
      `${scriptPath} must load the shared recovery helper`,
    );
    assert.match(
      script,
      /Start-RelayVMWithSavedStateFallback/u,
      `${scriptPath} must start through the shared fallback`,
    );
  }
});

test("checkpoint restore overlays the validated DialogGuard package without gating worker recovery", () => {
  const restore = fs.readFileSync(
    path.resolve("scripts/hyperv/Restore-Worker.ps1"),
    "utf8",
  );
  const sync = fs.readFileSync(
    path.resolve("scripts/hyperv/Sync-UnityDialogGuard.ps1"),
    "utf8",
  );
  const guest = fs.readFileSync(
    path.resolve("scripts/hyperv/Sync-UnityDialogGuard.Guest.ps1"),
    "utf8",
  );

  assert.match(restore, /try\s*\{[\s\S]*Sync-UnityDialogGuard\.ps1[\s\S]*\}\s*catch/u);
  assert.match(restore, /Optional DialogGuard sync/u);
  assert.match(sync, /validated[^\r\n]*-ne \$true/u);
  assert.match(sync, /Get-FileHash[\s\S]*SHA256/u);
  assert.match(guest, /guard-not-installed/u);
  assert.match(guest, /already-current/u);
  assert.match(guest, /update rolled back/u);
  assert.match(guest, /Stop-Process[\s\S]*\$guard\.ProcessId/u);
  assert.doesNotMatch(guest, /Stop-Process[^\r\n]*(Unity|Codex)/u);
});
