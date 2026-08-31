import { resolveWorkerTemplate } from "./util.mjs";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_SERVER_NAME = "relay-unityskills";
const UPSTREAM_TIMEOUT_MS = 15 * 60 * 1_000;

const tools = [
  {
    name: "unityskills_health",
    description:
      "Read the assigned Worker's live UnitySkills /health response, including Unity version, compilation state, queue state, and service version.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "unityskills_awareness",
    description:
      "Read UnitySkills awareness from GET /skills. Pass a raw query string such as 'summary=true' or supported manifest filters to keep the response focused.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional raw URL query string without a leading '?'.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "unityskills_schema",
    description:
      "Read UnitySkills schemas from GET /skills/schema. Use the optional raw query string to filter the large schema catalog.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional raw URL query string without a leading '?'.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "unityskills_recommend",
    description:
      "Ask UnitySkills to recommend skills for an intent through GET /skills/recommend. Example query: 'intent=inspect%20console&topN=10&includeSchema=true'.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "Required raw URL query string without a leading '?'.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "unityskills_chain",
    description:
      "Resolve a UnitySkills dependency chain through GET /skills/chain. Example query: 'output=instanceId&maxDepth=3'.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "Required raw URL query string without a leading '?'.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "unityskills_execute",
    description:
      "Execute, plan, or dry-run one named UnitySkills operation on the assigned Worker. Use mode='plan' for aggregate workflow planning and mode='dryRun' before real mutations.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          description: "Exact UnitySkills skill name from awareness/schema.",
        },
        mode: {
          type: "string",
          enum: ["execute", "plan", "dryRun"],
          default: "execute",
        },
        parameters: {
          type: "object",
          description:
            "JSON request body for the skill, including _confirm only when the skill contract requires it.",
          additionalProperties: true,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

function json(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(body);
}

function empty(response, status, headers = {}) {
  response.writeHead(status, headers);
  response.end();
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data = undefined) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

async function readJson(request, limitBytes = 1_048_576) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("MCP request body is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  return JSON.parse(text);
}

function rawQuery(value) {
  const query = String(value || "").trim();
  return query ? `?${query.replace(/^\?/u, "")}` : "";
}

function upstreamUrl(baseUrl, pathname, query = "") {
  const url = new URL(pathname, `${baseUrl.replace(/\/$/u, "")}/`);
  if (query) url.search = rawQuery(query);
  return url;
}

async function upstreamRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(
    upstreamUrl(baseUrl, pathname, options.query).toString(),
    {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        "X-Agent-Id": MCP_SERVER_NAME,
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    },
  );
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    text,
  };
}

function toolContent(upstream) {
  const prefix = upstream.ok ? "" : `UnitySkills HTTP ${upstream.status}: `;
  return {
    content: [{ type: "text", text: `${prefix}${upstream.text}` }],
    isError: !upstream.ok,
  };
}

async function callTool(baseUrl, params) {
  const name = params?.name;
  const args = params?.arguments || {};
  switch (name) {
    case "unityskills_health":
      return toolContent(await upstreamRequest(baseUrl, "/health"));
    case "unityskills_awareness":
      return toolContent(
        await upstreamRequest(baseUrl, "/skills", { query: args.query }),
      );
    case "unityskills_schema":
      return toolContent(
        await upstreamRequest(baseUrl, "/skills/schema", {
          query: args.query,
        }),
      );
    case "unityskills_recommend":
      if (!String(args.query || "").trim())
        throw Object.assign(new Error("query is required"), {
          rpcCode: -32602,
        });
      return toolContent(
        await upstreamRequest(baseUrl, "/skills/recommend", {
          query: args.query,
        }),
      );
    case "unityskills_chain":
      if (!String(args.query || "").trim())
        throw Object.assign(new Error("query is required"), {
          rpcCode: -32602,
        });
      return toolContent(
        await upstreamRequest(baseUrl, "/skills/chain", {
          query: args.query,
        }),
      );
    case "unityskills_execute": {
      const skillName = String(args.name || "").trim();
      if (!skillName)
        throw Object.assign(new Error("name is required"), { rpcCode: -32602 });
      const mode = args.mode || "execute";
      if (!["execute", "plan", "dryRun"].includes(mode))
        throw Object.assign(new Error("mode is invalid"), { rpcCode: -32602 });
      const query = mode === "execute" ? "" : `mode=${mode}`;
      return toolContent(
        await upstreamRequest(
          baseUrl,
          `/skill/${encodeURIComponent(skillName)}`,
          {
            method: "POST",
            query,
            body: args.parameters || {},
          },
        ),
      );
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name || "(missing)"}`), {
        rpcCode: -32602,
      });
  }
}

async function dispatch(baseUrl, message) {
  if (!message || message.jsonrpc !== "2.0" || !message.method)
    return rpcError(message?.id, -32600, "Invalid Request");
  const id = message.id;
  switch (message.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion:
          message.params?.protocolVersion || MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: "1.0.0" },
        instructions:
          "Use UnitySkills health, awareness, schema/recommend/chain, then plan and dry-run before executing real Unity operations.",
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools });
    case "tools/call":
      try {
        return rpcResult(id, await callTool(baseUrl, message.params));
      } catch (error) {
        return rpcError(
          id,
          error.rpcCode || -32603,
          error.message || "UnitySkills bridge failure",
        );
      }
    default:
      if (id === undefined) return null;
      return rpcError(id, -32601, "Method not found");
  }
}

export function isLoopbackAddress(address) {
  const normalized = String(address || "").toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

export function resolveUnitySkillsBaseUrl(project, worker) {
  const resolvedSkillUrl = resolveWorkerTemplate(
    project?.unitySkillUrl,
    worker,
  );
  const resolvedHealthUrl = resolveWorkerTemplate(
    project?.unityHealthUrl,
    worker,
  );
  const candidate = resolvedSkillUrl || resolvedHealthUrl;
  if (!candidate) return null;
  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
}

export async function handleUnitySkillsMcpRequest({
  request,
  response,
  baseUrl,
}) {
  if (request.method === "DELETE") {
    empty(response, 204);
    return;
  }
  if (request.method === "GET") {
    json(response, 405, rpcError(null, -32600, "SSE GET is not supported"), {
      Allow: "POST, DELETE",
    });
    return;
  }
  if (request.method !== "POST") {
    json(response, 405, rpcError(null, -32600, "Method not allowed"), {
      Allow: "POST, DELETE",
    });
    return;
  }

  let message;
  try {
    message = await readJson(request);
  } catch (error) {
    json(response, 400, rpcError(null, -32700, "Parse error", error.message));
    return;
  }

  if (Array.isArray(message)) {
    const results = (
      await Promise.all(message.map((entry) => dispatch(baseUrl, entry)))
    ).filter(Boolean);
    if (!results.length) empty(response, 202);
    else json(response, 200, results);
    return;
  }

  const result = await dispatch(baseUrl, message);
  if (!result) empty(response, 202);
  else json(response, 200, result);
}

export function unitySkillsMcpTools() {
  return structuredClone(tools);
}
