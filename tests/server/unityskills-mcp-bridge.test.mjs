import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  handleUnitySkillsMcpRequest,
  isLoopbackAddress,
  resolveUnitySkillsBaseUrl,
  unitySkillsMcpTools,
} from "../../server/unityskills-mcp-bridge.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("UnitySkills MCP bridge initializes and forwards health and dry-run calls", async (t) => {
  const upstreamRequests = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    upstreamRequests.push({ method: request.method, url: request.url, body });
    const payload =
      request.url === "/health"
        ? { status: "ok", service: "UnitySkills", version: "2.0.8" }
        : {
            status: "success",
            dryRun: true,
            received: JSON.parse(body || "{}"),
          };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  const upstreamBase = await listen(upstream);
  t.after(() => upstream.close());

  const bridge = http.createServer((request, response) =>
    handleUnitySkillsMcpRequest({
      request,
      response,
      baseUrl: upstreamBase,
    }),
  );
  const bridgeBase = await listen(bridge);
  t.after(() => bridge.close());

  const initialize = await fetch(bridgeBase, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }),
  }).then((response) => response.json());
  assert.equal(initialize.result.serverInfo.name, "relay-unityskills");
  assert.deepEqual(initialize.result.capabilities, {
    tools: { listChanged: false },
  });

  const health = await fetch(bridgeBase, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "unityskills_health", arguments: {} },
    }),
  }).then((response) => response.json());
  assert.equal(health.result.isError, false);
  assert.match(health.result.content[0].text, /"status":"ok"/u);

  const dryRun = await fetch(bridgeBase, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "unityskills_execute",
        arguments: {
          name: "gameobject_find",
          mode: "dryRun",
          parameters: { name: "Canvas" },
        },
      },
    }),
  }).then((response) => response.json());
  assert.equal(dryRun.result.isError, false);
  assert.deepEqual(upstreamRequests, [
    { method: "GET", url: "/health", body: "" },
    {
      method: "POST",
      url: "/skill/gameobject_find?mode=dryRun",
      body: '{"name":"Canvas"}',
    },
  ]);
});

test("UnitySkills MCP bridge exposes a bounded generic tool surface", () => {
  assert.deepEqual(
    unitySkillsMcpTools().map((tool) => tool.name),
    [
      "unityskills_health",
      "unityskills_awareness",
      "unityskills_schema",
      "unityskills_recommend",
      "unityskills_chain",
      "unityskills_execute",
    ],
  );
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("10.100.3.0"), false);
  assert.equal(
    resolveUnitySkillsBaseUrl(
      {
        unitySkillUrl: null,
        unityHealthUrl: "http://{corporateIp}:8090/health",
      },
      { corporateIp: "10.100.3.0" },
    ),
    "http://10.100.3.0:8090",
  );
});
