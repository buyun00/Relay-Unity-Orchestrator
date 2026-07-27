import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GuardianClient } from "../../server/guardian-client.mjs";

test("Relay starts Guardian after consecutive failed health checks and records recovery", async (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-guardian-client-test-"),
  );
  const events = [];
  let healthy = false;
  let starts = 0;
  const client = new GuardianClient(
    {
      guardianEnabled: true,
      guardianPort: 4318,
      guardianIntervalMs: 60_000,
      guardianFailureThreshold: 2,
      guardianRestartCooldownMs: 0,
      projectRoot: path.resolve("."),
      logDirectory: dataDirectory,
    },
    {
      onEvent: (event) => events.push(event),
      fetcher: async () => {
        if (!healthy) throw new Error("guardian unavailable");
        return { ok: true };
      },
      processStarter: () => {
        starts += 1;
        return { pid: 12345, unref() {} };
      },
    },
  );
  t.after(() => {
    client.stop();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  await client.check();
  assert.equal(starts, 0);
  await client.check();
  assert.equal(starts, 1);
  assert.ok(events.some((event) => event.type === "guardian.health.failed"));
  assert.ok(
    events.some((event) => event.type === "guardian.restart.requested"),
  );
  healthy = true;
  await client.check();
  assert.equal(client.status().reachable, true);
  assert.ok(events.some((event) => event.type === "guardian.health.recovered"));
});
