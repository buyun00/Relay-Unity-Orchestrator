import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("machine-scoped worker credentials round-trip without exposing broad file access", () => {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.resolve("tests/powershell/Test-MachineCredential.ps1"),
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      windowsHide: true,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout.trim());
  assert.deepEqual(output, {
    passed: 2,
    machineScopeRoundTrip: true,
    legacyCompatible: true,
    aclProtected: true,
  });
});
