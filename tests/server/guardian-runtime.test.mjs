import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitFor(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Guardian is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for ${url}`);
}

test("Guardian exposes an independent recovery page and System Codex snapshot while Relay is down", async (t) => {
  const guardianPort = await freePort();
  const relayPort = await freePort();
  const webPort = await freePort();
  const root = path.resolve(".");
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-guardian-runtime-test-"),
  );
  const child = spawn(process.execPath, ["server/guardian.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PIPELINE_GUARDIAN_HOST: "127.0.0.1",
      PIPELINE_GUARDIAN_PORT: String(guardianPort),
      PIPELINE_PORT: String(relayPort),
      PORT: String(webPort),
      PIPELINE_GUARDIAN_FAILURE_THRESHOLD: "1000",
      PIPELINE_GUARDIAN_INTERVAL_MS: "1000",
      PIPELINE_DATA_DIR: dataDirectory,
    },
    windowsHide: true,
    stdio: "ignore",
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  const healthResponse = await waitFor(
    `http://127.0.0.1:${guardianPort}/api/health`,
  );
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.service, "relay-guardian");
  const snapshot = await (
    await fetch(`http://127.0.0.1:${guardianPort}/api/snapshot`)
  ).json();
  assert.equal(snapshot.server.recoveryMode, true);
  assert.equal(snapshot.ops.thread.id, "guardian-emergency");
  const page = await (await fetch(`http://127.0.0.1:${guardianPort}/`)).text();
  assert.match(page, /Guardian 独立恢复入口/u);
  assert.match(page, /Emergency Codex/u);
});

test("Guardian starts real Relay and web child processes after health failures", async (t) => {
  const guardianPort = await freePort();
  const relayPort = await freePort();
  const webPort = await freePort();
  const internalWebPort = await freePort();
  const root = path.resolve(".");
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-guardian-process-test-"),
  );
  const child = spawn(process.execPath, ["server/guardian.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PIPELINE_GUARDIAN_HOST: "127.0.0.1",
      PIPELINE_GUARDIAN_PORT: String(guardianPort),
      PIPELINE_PORT: String(relayPort),
      PORT: String(webPort),
      RELAY_INTERNAL_WEB_PORT: String(internalWebPort),
      PIPELINE_GUARDIAN_FAILURE_THRESHOLD: "1",
      PIPELINE_GUARDIAN_INTERVAL_MS: "1000",
      PIPELINE_DATA_DIR: dataDirectory,
      PIPELINE_RELAY_ENTRY: "tests/server/fixtures/guardian-relay-service.mjs",
      PIPELINE_WEB_ENTRY: "tests/server/fixtures/guardian-web-service.mjs",
    },
    windowsHide: true,
    stdio: "ignore",
  });
  t.after(async () => {
    await Promise.allSettled([
      fetch(`http://127.0.0.1:${relayPort}/shutdown`, { method: "POST" }),
      fetch(`http://127.0.0.1:${webPort}/shutdown`, { method: "POST" }),
    ]);
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  await waitFor(`http://127.0.0.1:${guardianPort}/api/health`, 20_000);
  const relayHealth = await waitFor(
    `http://127.0.0.1:${relayPort}/api/health`,
    20_000,
  );
  assert.equal((await relayHealth.json()).service, "fixture-relay");
  const webPage = await (await waitFor(`http://127.0.0.1:${webPort}/`)).text();
  assert.match(webPage, /Fixture Relay Web/u);

  const health = await (
    await fetch(`http://127.0.0.1:${guardianPort}/api/health`)
  ).json();
  assert.ok(health.relay.restarts >= 1);
  assert.ok(health.web.restarts >= 1);
  assert.equal(health.lastError, null);
});
