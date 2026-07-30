import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const powershell =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const guestScript = new URL(
  "../../scripts/hyperv/Save-UnityProject.Guest.ps1",
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]:)/u, "$1");

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  );
  return server.address().port;
}

async function invokeGuestSave({
  configuredSaveUrl = "http://203.0.113.77:8090/api/save",
  guestEndpoint,
  timeoutSeconds = 3,
  connectionTimeoutSeconds = 2,
  retryCount = 0,
  retryDelayMilliseconds = 100,
  environment = {},
}) {
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    guestScript,
    "-ConfiguredSaveUrl",
    configuredSaveUrl,
    "-GuestUnitySkillsEndpoint",
    guestEndpoint,
    "-TimeoutSeconds",
    String(timeoutSeconds),
    "-ConnectionTimeoutSeconds",
    String(connectionTimeoutSeconds),
    "-DomainReloadRetryCount",
    String(retryCount),
    "-DomainReloadRetryDelayMilliseconds",
    String(retryDelayMilliseconds),
    "-OutputJson",
  ];
  try {
    const result = await execFileAsync(powershell, args, {
      windowsHide: true,
      timeout: 20_000,
      env: { ...process.env, ...environment },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: Number.isInteger(error.code) ? error.code : 1,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || error.message || ""),
    };
  }
}

test("guest save uses loopback when corporate endpoint is unavailable and proxy variables are inherited", async (t) => {
  const requests = [];
  const port = await listen(t, (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ url: request.url, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ saved: true }));
    });
  });

  const result = await invokeGuestSave({
    guestEndpoint: `http://127.0.0.1:${port}`,
    environment: {
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.saved, true);
  assert.equal(output.proxyDisabled, true);
  assert.equal(output.endpoint, `http://127.0.0.1:${port}/api/save`);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/save");
  assert.deepEqual(JSON.parse(requests[0].body), {
    waitForCompletion: true,
    action: "saveAll",
  });
});

test("guest save distinguishes an OS connection refusal from its bounded timeout", () => {
  const source = fs.readFileSync(guestScript, "utf8");
  assert.match(
    source,
    /SocketErrorCode\s+-eq\s*\r?\n?\s*\[System\.Net\.Sockets\.SocketError\]::ConnectionRefused/u,
  );
  assert.match(source, /-Code 'UNITY_SAVE_CONNECTION_REFUSED'/u);
  assert.match(source, /-Code 'UNITY_SAVE_CONNECTION_TIMEOUT'/u);
  assert.match(source, /-Code 'UNITY_SAVE_RESPONSE_TIMEOUT'/u);
});

test("guest save reports a bounded response timeout distinctly", async (t) => {
  const port = await listen(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    setTimeout(() => response.end(JSON.stringify({ saved: true })), 2_000);
  });
  const result = await invokeGuestSave({
    guestEndpoint: `http://127.0.0.1:${port}`,
    timeoutSeconds: 1,
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /\[UNITY_SAVE_RESPONSE_TIMEOUT\]/u);
});

test("guest save rejects invalid JSON distinctly", async (t) => {
  const port = await listen(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("not-json");
  });
  const result = await invokeGuestSave({
    guestEndpoint: `http://127.0.0.1:${port}`,
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /\[UNITY_SAVE_INVALID_RESPONSE\]/u);
});

test("guest save reports non-success HTTP status distinctly", async (t) => {
  const port = await listen(t, (_request, response) => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "failed" }));
  });
  const result = await invokeGuestSave({
    guestEndpoint: `http://127.0.0.1:${port}`,
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /\[UNITY_SAVE_HTTP_FAILURE\]/u);
  assert.match(result.stderr, /HTTP 500/u);
});

test("guest save retries a bounded Unity domain reload and then succeeds", async (t) => {
  let attempts = 0;
  const port = await listen(t, (_request, response) => {
    attempts += 1;
    if (attempts < 3) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unity domain reload busy" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ saved: true }));
  });
  const result = await invokeGuestSave({
    guestEndpoint: `http://127.0.0.1:${port}`,
    retryCount: 2,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(attempts, 3);
  assert.equal(JSON.parse(result.stdout.trim()).attempts, 3);
});
