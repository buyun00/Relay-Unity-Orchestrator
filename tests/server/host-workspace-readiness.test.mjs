import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("host workspace readiness tolerates startup races but keeps a bounded failure", () => {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.resolve("tests/powershell/Test-HostWorkspaceReadiness.ps1"),
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 },
  );
  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr, result.error].filter(Boolean).join("\n"),
  );
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    passed: 5,
    startupRaceRecovered: true,
    persistentFailurePreserved: true,
  });
});

test("workspace preparation waits before mutation and before reporting ready", () => {
  const source = fs.readFileSync(
    "scripts/hyperv/Prepare-Workspace.ps1",
    "utf8",
  );
  const firstProbe = source.indexOf("$smbReady = Wait-RelayHostWorkspace");
  const guestMutation = source.indexOf("Invoke-RelayPowerShellDirect");
  const secondProbe = source.lastIndexOf("$smbReady = Wait-RelayHostWorkspace");
  assert.ok(firstProbe >= 0 && firstProbe < guestMutation);
  assert.ok(secondProbe > guestMutation);
  assert.match(
    source,
    /\$hostSmbWaitSeconds = \[Math\]::Min\(60, \$TimeoutSeconds\)/u,
  );
  assert.match(source, /smbReady = \$smbReady/u);
  assert.doesNotMatch(source, /Test-Path -LiteralPath \$SharePath/u);
});
