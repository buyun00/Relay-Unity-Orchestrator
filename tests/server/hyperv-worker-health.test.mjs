import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("worker health refreshes an unauthorized SYSTEM SMB session without collapsing other health fields", () => {
  const script = path.resolve(
    "tests/powershell/Test-WorkerHealthSmbRecovery.ps1",
  );
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
  assert.deepEqual(JSON.parse(output), {
    passed: 2,
    authenticatedRecovery: true,
    failureStructured: true,
  });
});
