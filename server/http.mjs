import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  errorPayload,
  executionProfile,
  gitRef,
  HttpError,
  integer,
  requiredString,
  safeFilename,
} from "./util.mjs";
import { codexTaskSettings } from "./codex-settings.mjs";
import { requestUserName } from "./daily-audit-log.mjs";
import { QA_HUB_M2M_BASE_PATH } from "./qa-hub-m2m.mjs";
import {
  isActionableProjectManagementDefect,
  projectManagementTaskKey,
  projectManagementTaskPrompt,
  projectManagementTaskTitle,
} from "./project-management-client.mjs";
import {
  handleUnitySkillsMcpRequest,
  isLoopbackAddress,
  resolveUnitySkillsBaseUrl,
} from "./unityskills-mcp-bridge.mjs";

const PROJECT_MANAGEMENT_SESSION_COOKIE = "relay-project-management-session";
const PROJECT_MANAGEMENT_BROWSER_COOKIE = "relay-project-management-browser";

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

function html(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(body);
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function empty(response, status = 204, headers = {}) {
  response.writeHead(status, headers);
  response.end();
}

function readBuffer(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(
          new HttpError(
            413,
            "PAYLOAD_TOO_LARGE",
            `Request body exceeds ${limit} bytes`,
          ),
        );
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function removePreparedAttachments(attachments) {
  for (const attachment of attachments || []) {
    try {
      fs.rmSync(attachment.path, { force: true });
    } catch {
      // Best-effort cleanup; the database never references these paths.
    }
  }
}

function persistProjectManagementImages(config, images) {
  const attachments = [];
  try {
    for (const image of images || []) {
      if (
        !Buffer.isBuffer(image?.buffer) ||
        !image.buffer.length ||
        image.buffer.length > config.uploadLimitBytes ||
        !String(image.contentType || "").startsWith("image/")
      ) {
        throw new HttpError(
          502,
          "PROJECT_MANAGEMENT_IMAGE_INVALID",
          "轻语图片下载结果无效，任务尚未创建",
        );
      }
      const filename = safeFilename(image.filename);
      const diskPath = path.join(
        config.uploadDirectory,
        `${crypto.randomUUID()}-${filename}`,
      );
      fs.writeFileSync(diskPath, image.buffer, { flag: "wx" });
      attachments.push({
        filename,
        path: diskPath,
        contentType: image.contentType,
        size: image.buffer.length,
      });
    }
    return attachments;
  } catch (error) {
    removePreparedAttachments(attachments);
    throw error;
  }
}

async function readJson(request, limit) {
  const buffer = await readBuffer(request, limit);
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}

function projectInput(body, partial = false) {
  const result = {};
  const stringFields = [
    "name",
    "repoUrl",
    "defaultBranch",
    "guestProjectPath",
    "smbPath",
    "unityVersion",
    "unitySkillUrl",
    "unityHealthUrl",
    "unitySaveUrl",
    "checkpointName",
    "buildProjectKey",
  ];
  for (const field of stringFields) {
    if (Object.hasOwn(body, field)) {
      if (typeof body[field] !== "string")
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          `${field} must be a string`,
        );
      result[field] = body[field].trim() || null;
    }
  }
  if (!partial) {
    result.name = requiredString(body.name, "name", { max: 120 });
    result.repoUrl = requiredString(body.repoUrl, "repoUrl", { max: 2_000 });
    result.guestProjectPath = requiredString(
      body.guestProjectPath,
      "guestProjectPath",
      { max: 1_000 },
    );
    result.smbPath = requiredString(body.smbPath, "smbPath", { max: 1_000 });
    result.defaultBranch ||= "main";
  }
  if (result.defaultBranch)
    result.defaultBranch = gitRef(result.defaultBranch, "defaultBranch");
  if (Object.hasOwn(body, "enabled")) result.enabled = Boolean(body.enabled);
  if (Object.hasOwn(body, "autoBuildEnabled"))
    result.autoBuildEnabled = Boolean(body.autoBuildEnabled);
  return result;
}

function workerInput(body, partial = false) {
  const result = {};
  const stringFields = [
    "name",
    "vmName",
    "projectId",
    "checkpointName",
    "internalIp",
    "corporateIp",
    "sharePath",
    "credentialPath",
  ];
  for (const field of stringFields) {
    if (Object.hasOwn(body, field)) {
      if (body[field] != null && typeof body[field] !== "string") {
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          `${field} must be a string`,
        );
      }
      result[field] = body[field]?.trim() || null;
    }
  }
  if (!partial) {
    result.name = requiredString(body.name, "name", { max: 120 });
    result.vmName = body.vmName?.trim() || result.name;
    result.sharePath = requiredString(body.sharePath, "sharePath", {
      max: 1_000,
    });
  }
  if (Object.hasOwn(body, "enabled")) result.enabled = Boolean(body.enabled);
  return result;
}

function routeId(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (!rest || rest.includes("/")) return null;
  return decodeURIComponent(rest);
}

function cookieValue(request, name) {
  const header = String(request.headers.cookie || "");
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function projectManagementCookie(request, name, value, maxAge) {
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "")
    .split(",", 1)[0]
    .trim()
    .toLowerCase();
  const origin = String(request.headers.origin || "");
  const secure =
    forwardedProtocol === "https" ||
    origin.toLowerCase().startsWith("https://");
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function projectManagementSessionCookies(request, sessionId, browserId) {
  return [
    projectManagementCookie(
      request,
      PROJECT_MANAGEMENT_SESSION_COOKIE,
      sessionId,
      43_200,
    ),
    projectManagementCookie(
      request,
      PROJECT_MANAGEMENT_BROWSER_COOKIE,
      browserId,
      31_536_000,
    ),
  ];
}

function opaqueCookieId(value) {
  const candidate = String(value || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    candidate,
  )
    ? candidate
    : null;
}

function normalizedProjectName(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/gu, "");
}

const INLINE_ATTACHMENT_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function attachmentContentType(value) {
  const contentType = String(value || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(
    contentType,
  )
    ? contentType
    : "application/octet-stream";
}

function attachmentDisposition(filename, inline) {
  const normalized = String(filename || "attachment.bin")
    .toWellFormed()
    .replace(/[\x00-\x1f\x7f]/gu, "_");
  const safeAscii =
    normalized.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_") ||
    "attachment.bin";
  const encoded = encodeURIComponent(normalized).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? "inline" : "attachment"}; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}

function publicRuntimeStatus(runtime) {
  if (!runtime) return null;
  return {
    ready: runtime.ready,
    checkedAt: runtime.checkedAt,
    checkpointsEnabled: runtime.checkpointsEnabled,
    hyperv: {
      moduleAvailable: Boolean(runtime.hyperv?.moduleAvailable),
      canManage: Boolean(runtime.hyperv?.canManage),
      vmCount: Number(runtime.hyperv?.vmCount || 0),
      error: runtime.hyperv?.error || null,
    },
    codex: {
      available: Boolean(runtime.codex?.available),
      authenticated: Boolean(runtime.codex?.authenticated),
      version: runtime.codex?.version || null,
      error: runtime.codex?.error || null,
    },
  };
}

export class PipelineHttpServer {
  constructor({
    config,
    store,
    scheduler,
    ops = null,
    guardian = null,
    auditLog = null,
    checkpointMaintenance = null,
    projectManagementClient = null,
    taskCompletionService = null,
    qaHubM2mService = null,
  }) {
    this.config = config;
    this.store = store;
    this.scheduler = scheduler;
    this.ops = ops;
    this.guardian = guardian;
    this.auditLog = auditLog;
    this.checkpointMaintenance = checkpointMaintenance;
    this.projectManagementClient = projectManagementClient;
    this.taskCompletionService = taskCompletionService;
    this.qaHubM2mService = qaHubM2mService;
    this.sseClients = new Set();
    this.unsubscribe = store.onEvent((event) => this.broadcast(event));
    this.server = http.createServer(
      (request, response) => void this.handle(request, response),
    );
  }

  originAllowed(request) {
    const origin = request.headers.origin;
    if (!origin) return true;
    if (this.config.allowedOrigins.includes(origin)) return true;
    try {
      const parsed = new URL(origin);
      const requestHostname = String(request.headers.host || "")
        .split(":")[0]
        .replace(/^\[|\]$/g, "");
      return (
        ["http:", "https:"].includes(parsed.protocol) &&
        (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
          parsed.hostname === requestHostname)
      );
    } catch {
      return false;
    }
  }

  corsHeaders(request) {
    const origin = request.headers.origin;
    return origin && this.originAllowed(request)
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Headers":
            "Content-Type, Idempotency-Key, X-File-Name, X-Pipeline-User",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Max-Age": "600",
          Vary: "Origin",
        }
      : {};
  }

  projectManagementSession(request, responseHeaders) {
    if (!this.projectManagementClient) {
      throw new HttpError(
        503,
        "PROJECT_MANAGEMENT_DISABLED",
        "项目管理系统集成尚未启用",
      );
    }
    const requestedSessionId = cookieValue(
      request,
      PROJECT_MANAGEMENT_SESSION_COOKIE,
    );
    const browserId =
      opaqueCookieId(cookieValue(request, PROJECT_MANAGEMENT_BROWSER_COOKIE)) ||
      crypto.randomUUID();
    const session = this.projectManagementClient.ensureSession(
      opaqueCookieId(requestedSessionId),
      {
        browserId,
        relayUserName: requestUserName(request),
      },
    );
    responseHeaders["Set-Cookie"] = projectManagementSessionCookies(
      request,
      session.id,
      browserId,
    );
    return session.id;
  }

  broadcast(event) {
    const message = `id: ${event.id}\nevent: pipeline\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(message);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  handleSse(request, response, url, cors) {
    response.writeHead(200, {
      ...cors,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    const afterId = integer(
      request.headers["last-event-id"] || url.searchParams.get("afterId"),
      0,
      0,
    );
    for (const event of this.store.listEvents({ afterId, limit: 250 })) {
      response.write(
        `id: ${event.id}\nevent: pipeline\ndata: ${JSON.stringify(event)}\n\n`,
      );
    }
    response.write(
      `event: ready\ndata: ${JSON.stringify({ now: new Date().toISOString() })}\n\n`,
    );
    this.sseClients.add(response);
    const heartbeat = setInterval(
      () => response.write(`: heartbeat ${Date.now()}\n\n`),
      20_000,
    );
    request.on("close", () => {
      clearInterval(heartbeat);
      this.sseClients.delete(response);
    });
  }

  async handle(request, response) {
    this.auditLog?.trackAccess(request, response);
    const cors = this.corsHeaders(request);
    try {
      if (!this.originAllowed(request))
        throw new HttpError(
          403,
          "ORIGIN_NOT_ALLOWED",
          "Request origin is not allowed",
        );
      if (request.method === "OPTIONS") {
        empty(response, 204, cors);
        return;
      }
      const url = new URL(
        request.url || "/",
        `http://${request.headers.host || "localhost"}`,
      );
      const pathname = url.pathname.replace(/\/$/, "") || "/";
      const actorName = requestUserName(request);

      if (
        this.qaHubM2mService &&
        (pathname === QA_HUB_M2M_BASE_PATH ||
          pathname.startsWith(`${QA_HUB_M2M_BASE_PATH}/`))
      ) {
        const body =
          request.method === "GET"
            ? {}
            : await readJson(request, this.config.requestBodyLimitBytes);
        const result = await this.qaHubM2mService.handle({
          method: request.method,
          url: request.url,
          headers: request.headers,
          remoteAddress: request.socket?.remoteAddress,
          body,
        });
        json(response, result.statusCode ?? result.status ?? 500, result.body, {
          ...cors,
          ...(result.headers || {}),
        });
        return;
      }

      if (request.method === "GET" && pathname === "/") {
        const dashboardUrl = new URL(url);
        dashboardUrl.port = "3000";
        dashboardUrl.pathname = "/";
        dashboardUrl.search = "";
        dashboardUrl.hash = "";
        const scheduler = this.scheduler.status();
        const adapter = escapeHtml(this.config.adapter);
        const version = escapeHtml(this.config.version);
        const state = scheduler.paused ? "已暂停" : "运行中";
        const stateClass = scheduler.paused ? "warning" : "healthy";
        html(
          response,
          200,
          `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Relay 控制服务</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, "Segoe UI", sans-serif; background: #090d12; color: #f4f7fb; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 32px; background: radial-gradient(circle at 20% 10%, #17324a 0, transparent 36%), #090d12; }
    main { width: min(720px, 100%); padding: 36px; border: 1px solid #263241; border-radius: 24px; background: rgba(15, 21, 29, .92); box-shadow: 0 24px 80px rgba(0,0,0,.4); }
    .eyebrow { color: #76e6b4; font-size: 12px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
    h1 { margin: 12px 0 8px; font-size: clamp(30px, 5vw, 48px); }
    p { margin: 0; color: #aeb9c7; line-height: 1.7; }
    dl { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 28px 0; }
    dl div { padding: 16px; border: 1px solid #273544; border-radius: 16px; background: #111922; }
    dt { color: #8492a4; font-size: 12px; }
    dd { margin: 7px 0 0; font-weight: 750; }
    .healthy { color: #76e6b4; }
    .warning { color: #ffd27a; }
    nav { display: flex; flex-wrap: wrap; gap: 10px; }
    a { color: #07120e; background: #76e6b4; padding: 12px 16px; border-radius: 12px; font-weight: 800; text-decoration: none; }
    a.secondary { color: #dce5ee; background: #1b2632; }
    @media (max-width: 560px) { main { padding: 24px; } dl { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Relay control plane</div>
    <h1>控制服务在线</h1>
    <p>这是 Unity 自动化调度台的本地控制接口。日常操作请进入管理网页；这里用于确认服务状态和接口健康。</p>
    <dl>
      <div><dt>服务状态</dt><dd class="${stateClass}">${state}</dd></div>
      <div><dt>适配器</dt><dd>${adapter}</dd></div>
      <div><dt>版本</dt><dd>${version}</dd></div>
      <div><dt>活动轮次</dt><dd>${scheduler.activeTurns}</dd></div>
    </dl>
    <nav>
      <a href="${escapeHtml(dashboardUrl.toString())}">进入管理网页</a>
      <a class="secondary" href="/api/health">查看健康数据</a>
    </nav>
  </main>
</body>
</html>`,
          cors,
        );
        return;
      }

      if (request.method === "GET" && pathname === "/api/health") {
        const runtime = this.scheduler.runtimeStatus();
        json(
          response,
          200,
          {
            ok: true,
            version: this.config.version,
            adapter: this.config.adapter,
            scheduler: this.scheduler.status(),
            ops: this.ops?.status?.() || {
              enabled: false,
              running: false,
            },
            guardian: this.guardian?.status?.() || {
              enabled: false,
              reachable: false,
            },
            checkpointMaintenance:
              this.checkpointMaintenance?.status?.() || null,
            runtime: publicRuntimeStatus(runtime),
            uptimeSeconds: Math.round(process.uptime()),
            now: new Date().toISOString(),
          },
          cors,
        );
        return;
      }

      if (request.method === "GET" && pathname === "/api/runtime") {
        const runtime = await this.scheduler.inspectRuntime({ force: true });
        json(response, 200, { ok: true, runtime }, cors);
        return;
      }

      if (request.method === "GET" && pathname === "/api/events") {
        this.handleSse(request, response, url, cors);
        return;
      }

      if (request.method === "GET" && pathname === "/api/snapshot") {
        const snapshot = this.store.snapshot();
        const scheduler = this.scheduler.status();
        const runtime = this.scheduler.runtimeStatus();
        json(
          response,
          200,
          {
            ...snapshot,
            server: {
              version: this.config.version,
              adapter: this.config.adapter,
              mode: this.config.adapter,
              now: new Date().toISOString(),
              queuePaused: scheduler.paused,
              schedulerRunning: scheduler.running && !scheduler.paused,
              runtime,
              ops: this.ops?.status?.() || null,
              guardian: this.guardian?.status?.() || null,
              checkpointMaintenance:
                this.checkpointMaintenance?.status?.() || null,
            },
          },
          cors,
        );
        return;
      }

      if (
        request.method === "GET" &&
        pathname === "/api/project-management/session"
      ) {
        const sessionId = this.projectManagementSession(request, cors);
        json(
          response,
          200,
          {
            ok: true,
            session: this.projectManagementClient.publicSession(sessionId),
          },
          cors,
        );
        return;
      }
      if (
        request.method === "POST" &&
        pathname === "/api/project-management/login/start"
      ) {
        const sessionId = this.projectManagementSession(request, cors);
        json(
          response,
          200,
          {
            ok: true,
            session: await this.projectManagementClient.startLogin(sessionId),
          },
          cors,
        );
        return;
      }
      if (
        request.method === "GET" &&
        pathname === "/api/project-management/login/status"
      ) {
        const sessionId = this.projectManagementSession(request, cors);
        json(
          response,
          200,
          {
            ok: true,
            session: await this.projectManagementClient.pollLogin(sessionId),
          },
          cors,
        );
        return;
      }
      if (
        request.method === "POST" &&
        pathname === "/api/project-management/logout"
      ) {
        const sessionId = this.projectManagementSession(request, cors);
        json(
          response,
          200,
          {
            ok: true,
            session: await this.projectManagementClient.logout(sessionId),
          },
          cors,
        );
        return;
      }
      if (
        request.method === "GET" &&
        pathname === "/api/project-management/projects"
      ) {
        const sessionId = this.projectManagementSession(request, cors);
        const relayProjectId = requiredString(
          url.searchParams.get("relayProjectId"),
          "relayProjectId",
          { max: 200 },
        );
        const relayProject = this.store.getProject(relayProjectId);
        if (!relayProject) {
          throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found");
        }
        const projects =
          await this.projectManagementClient.listProjects(sessionId);
        let selectedProjectId = this.projectManagementClient.selectedProject(
          sessionId,
          relayProjectId,
        );
        if (!projects.some((project) => project.id === selectedProjectId)) {
          const relayName = normalizedProjectName(relayProject.name);
          selectedProjectId =
            projects.find(
              (project) => normalizedProjectName(project.name) === relayName,
            )?.id || (projects.length === 1 ? projects[0].id : null);
        }
        if (selectedProjectId) {
          this.projectManagementClient.rememberProject(
            sessionId,
            relayProjectId,
            selectedProjectId,
          );
        }
        json(response, 200, { ok: true, projects, selectedProjectId }, cors);
        return;
      }
      if (
        request.method === "GET" &&
        pathname === "/api/project-management/defects"
      ) {
        const sessionId = this.projectManagementSession(request, cors);
        const relayProjectId = requiredString(
          url.searchParams.get("relayProjectId"),
          "relayProjectId",
          { max: 200 },
        );
        const externalProjectId = requiredString(
          url.searchParams.get("externalProjectId"),
          "externalProjectId",
          { max: 200 },
        );
        if (!this.store.getProject(relayProjectId)) {
          throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found");
        }
        this.projectManagementClient.rememberProject(
          sessionId,
          relayProjectId,
          externalProjectId,
        );
        const listed = await this.projectManagementClient.listDefects(
          sessionId,
          {
            externalProjectId,
            page: integer(url.searchParams.get("page"), 1, 1, 10_000),
            pageSize: integer(url.searchParams.get("pageSize"), 100, 1, 200),
            search: url.searchParams.get("search") || "",
          },
        );
        const actionableDefects = listed.defects.filter(
          isActionableProjectManagementDefect,
        );
        const defects = actionableDefects.map((defect) => {
          const importedTask = this.store.getTaskByIdempotencyKey(
            projectManagementTaskKey({
              relayProjectId,
              externalProjectId,
              defectId: defect.id,
            }),
          );
          return {
            ...defect,
            importedTask: importedTask
              ? {
                  id: importedTask.id,
                  number: importedTask.number,
                  status: importedTask.status,
                  title: importedTask.title,
                }
              : null,
          };
        });
        json(
          response,
          200,
          { ok: true, ...listed, total: defects.length, defects },
          cors,
        );
        return;
      }
      const projectManagementDefect = pathname.match(
        /^\/api\/project-management\/defects\/([^/]+)$/u,
      );
      if (projectManagementDefect && request.method === "GET") {
        const sessionId = this.projectManagementSession(request, cors);
        const relayProjectId = requiredString(
          url.searchParams.get("relayProjectId"),
          "relayProjectId",
          { max: 200 },
        );
        const externalProjectId = requiredString(
          url.searchParams.get("externalProjectId"),
          "externalProjectId",
          { max: 200 },
        );
        const defect = await this.projectManagementClient.getDefect(
          sessionId,
          decodeURIComponent(projectManagementDefect[1]),
        );
        const importedTask = this.store.getTaskByIdempotencyKey(
          projectManagementTaskKey({
            relayProjectId,
            externalProjectId,
            defectId: defect.id,
          }),
        );
        json(
          response,
          200,
          {
            ok: true,
            defect: {
              ...defect,
              importedTask: importedTask
                ? {
                    id: importedTask.id,
                    number: importedTask.number,
                    status: importedTask.status,
                    title: importedTask.title,
                  }
                : null,
            },
          },
          cors,
        );
        return;
      }
      if (
        request.method === "POST" &&
        pathname === "/api/project-management/import"
      ) {
        const sessionId = this.projectManagementSession(request, cors);
        const session = this.projectManagementClient.publicSession(sessionId);
        if (!session.authenticated) {
          throw new HttpError(
            401,
            "PROJECT_MANAGEMENT_AUTH_REQUIRED",
            "请先使用轻羽 APP 扫码登录",
          );
        }
        const completionBinding =
          this.projectManagementClient.completionBinding(sessionId);
        const body = await readJson(request, this.config.requestBodyLimitBytes);
        const relayProjectId = requiredString(body.projectId, "projectId", {
          max: 200,
        });
        const relayProject = this.store.getProject(relayProjectId);
        if (!relayProject || !relayProject.enabled) {
          throw new HttpError(
            400,
            "PROJECT_NOT_AVAILABLE",
            "Project is not available",
          );
        }
        const externalProjectId = requiredString(
          body.externalProjectId,
          "externalProjectId",
          { max: 200 },
        );
        if (!Array.isArray(body.items) || body.items.length === 0) {
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            "items must contain at least one defect",
          );
        }
        if (body.items.length > 30) {
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            "A maximum of 30 defects can be imported at once",
          );
        }
        const taskCodexSettings = codexTaskSettings(body, {
          codexModel: this.config.codexModel,
          codexReasoningEffort: this.config.codexReasoningEffort,
          codexFastMode: this.config.codexServiceTier === "fast",
        });
        const priority = integer(body.priority, 0, -100, 100);
        const turnExecutionProfile = executionProfile(body.executionProfile);
        const uniqueDefectIds = new Set();
        const requestedItems = body.items.map((item, index) => {
          if (!item || typeof item !== "object") {
            throw new HttpError(
              400,
              "VALIDATION_ERROR",
              `items[${index}] must be an object`,
            );
          }
          const defectId = requiredString(
            item.defectId,
            `items[${index}].defectId`,
            {
              max: 200,
            },
          );
          if (uniqueDefectIds.has(defectId)) {
            throw new HttpError(
              400,
              "VALIDATION_ERROR",
              `Duplicate defect id: ${defectId}`,
            );
          }
          uniqueDefectIds.add(defectId);
          const extraPrompt = String(item.extraPrompt || "").trim();
          if (extraPrompt.length > 50_000) {
            throw new HttpError(
              400,
              "VALIDATION_ERROR",
              `items[${index}].extraPrompt is too long`,
            );
          }
          const attachmentIds = Array.isArray(item.attachmentIds)
            ? [...new Set(item.attachmentIds.map((value) => String(value)))]
            : [];
          if (
            attachmentIds.length > 20 ||
            attachmentIds.some(
              (value) => !value || value.length > 200 || /[\r\n]/u.test(value),
            )
          ) {
            throw new HttpError(
              400,
              "VALIDATION_ERROR",
              `items[${index}].attachmentIds is invalid`,
            );
          }
          return { defectId, extraPrompt, attachmentIds };
        });
        this.projectManagementClient.rememberProject(
          sessionId,
          relayProjectId,
          externalProjectId,
        );
        const results = [];
        let createdCount = 0;
        for (const item of requestedItems) {
          const idempotencyKey = projectManagementTaskKey({
            relayProjectId,
            externalProjectId,
            defectId: item.defectId,
          });
          const existing = this.store.getTaskByIdempotencyKey(idempotencyKey);
          if (existing) {
            const linkedTask = this.store.linkProjectManagementTask(
              existing.id,
              {
                externalProjectId,
                defectId: item.defectId,
                defectUrl: this.projectManagementClient.defectUrl(
                  item.defectId,
                ),
                ...completionBinding,
              },
              actorName,
            );
            results.push({
              defectId: item.defectId,
              status: "duplicate",
              task: linkedTask,
            });
            continue;
          }
          let preparedAttachments = [];
          try {
            const defect = await this.projectManagementClient.getDefect(
              sessionId,
              item.defectId,
            );
            if (!isActionableProjectManagementDefect(defect)) {
              throw new HttpError(
                409,
                "PROJECT_MANAGEMENT_DEFECT_NOT_ACTIONABLE",
                `轻语缺陷当前状态为“${defect.status || "已结束"}”，不能创建任务，请刷新列表`,
              );
            }
            const downloadedImages =
              await this.projectManagementClient.downloadDefectImages(
                sessionId,
                defect,
                { limitBytes: this.config.uploadLimitBytes },
              );
            preparedAttachments = persistProjectManagementImages(
              this.config,
              downloadedImages,
            );
            const created = this.store.createTask({
              projectId: relayProjectId,
              title: projectManagementTaskTitle(defect),
              message: projectManagementTaskPrompt(defect, item.extraPrompt),
              baseBranch:
                body.baseBranch == null
                  ? relayProject.defaultBranch
                  : gitRef(body.baseBranch, "baseBranch"),
              priority,
              autoRelease: body.autoRelease !== false,
              executionProfile: turnExecutionProfile,
              ...taskCodexSettings,
              attachments: item.attachmentIds,
              preparedAttachments,
              idempotencyKey,
              userName: session.user?.name || actorName,
              projectManagement: {
                externalProjectId,
                defectId: item.defectId,
                defectUrl: defect.url,
                ...completionBinding,
              },
            });
            if (created.duplicate) {
              removePreparedAttachments(preparedAttachments);
              preparedAttachments = [];
            }
            if (!created.duplicate) createdCount += 1;
            results.push({
              defectId: item.defectId,
              status: created.duplicate ? "duplicate" : "created",
              task: created.task,
              turn: created.turn,
            });
          } catch (error) {
            removePreparedAttachments(preparedAttachments);
            if (error?.status === 401) throw error;
            results.push({
              defectId: item.defectId,
              status: "failed",
              error: {
                code: error?.code || "PROJECT_MANAGEMENT_IMPORT_FAILED",
                message: error?.message || "创建任务失败",
              },
            });
          }
        }
        if (createdCount > 0) this.scheduler.notifyQueueChanged();
        const duplicateCount = results.filter(
          (item) => item.status === "duplicate",
        ).length;
        const failedCount = results.filter(
          (item) => item.status === "failed",
        ).length;
        json(
          response,
          createdCount > 0 ? 201 : 200,
          {
            ok: failedCount === 0,
            created: createdCount,
            duplicates: duplicateCount,
            failed: failedCount,
            results,
          },
          cors,
        );
        return;
      }

      if (request.method === "GET" && pathname === "/api/ops") {
        json(
          response,
          200,
          {
            ok: true,
            status: this.ops?.status?.() || {
              enabled: false,
              running: false,
            },
            thread: this.store.getOpsThread(),
            threads: this.store.listOpsThreads(),
            turns: this.store.listOpsTurns(),
            incidents: this.store.listIncidents(),
            actions: this.store.listOpsActions(),
            repairs: this.store.listRepairRuns(),
          },
          cors,
        );
        return;
      }
      if (request.method === "POST" && pathname === "/api/ops/threads") {
        const body = await readJson(request, this.config.requestBodyLimitBytes);
        const settings = codexTaskSettings(body, {
          codexModel: this.config.opsCodexModel || this.config.codexModel,
          codexReasoningEffort:
            this.config.opsCodexReasoningEffort ||
            this.config.codexReasoningEffort,
          codexFastMode: this.config.opsCodexFastMode,
        });
        const thread = this.store.createOpsThread({
          title: requiredString(body.title, "title", { max: 120 }),
          ...settings,
        });
        this.store.emit({
          actorName,
          type: "ops.thread.created",
          phase: "ops",
          message: `System Codex conversation created: ${thread.title}`,
          data: { threadId: thread.id },
        });
        json(response, 201, { ok: true, thread }, cors);
        return;
      }
      const opsThreadMutation = pathname.match(
        /^\/api\/ops\/threads\/([^/]+)(?:\/(clear))?$/,
      );
      if (opsThreadMutation) {
        const threadId = decodeURIComponent(opsThreadMutation[1]);
        const action = opsThreadMutation[2] || null;
        const current = this.store.getOpsThread(threadId);
        if (!current)
          throw new HttpError(
            404,
            "OPS_THREAD_NOT_FOUND",
            "System Codex conversation not found",
          );
        if (request.method === "PATCH" && !action) {
          const body = await readJson(
            request,
            this.config.requestBodyLimitBytes,
          );
          if (["queued", "running"].includes(current.status)) {
            throw new HttpError(
              409,
              "OPS_THREAD_ACTIVE",
              "Wait for the active System Codex turn before changing settings",
            );
          }
          const settings = codexTaskSettings(body, current);
          const thread = this.store.updateOpsThread(threadId, {
            title:
              body.title == null
                ? current.title
                : requiredString(body.title, "title", { max: 120 }),
            ...settings,
          });
          json(response, 200, { ok: true, thread }, cors);
          return;
        }
        if (request.method === "POST" && action === "clear") {
          const thread = this.store.clearOpsThread(threadId);
          this.store.emit({
            actorName,
            type: "ops.thread.cleared",
            phase: "ops",
            message: `System Codex screen cleared: ${thread.title}`,
            data: {
              threadId,
              clearedThroughSequence: thread.clearedThroughSequence,
            },
          });
          json(response, 200, { ok: true, thread }, cors);
          return;
        }
      }
      if (request.method === "POST" && pathname === "/api/ops/messages") {
        if (!this.ops)
          throw new HttpError(
            503,
            "OPS_NOT_RUNNING",
            "System Codex is not running",
          );
        const body = await readJson(request, this.config.requestBodyLimitBytes);
        const turn = this.ops.sendMessage(
          requiredString(body.message, "message", { max: 100_000 }),
          actorName,
          body.threadId == null
            ? "ops-system"
            : requiredString(body.threadId, "threadId", { max: 200 }),
        );
        json(response, 201, { ok: true, turn }, cors);
        return;
      }
      const incidentMutation = pathname.match(
        /^\/api\/incidents\/([^/]+)\/(diagnose|resolve)$/,
      );
      if (incidentMutation && request.method === "POST") {
        const incidentId = decodeURIComponent(incidentMutation[1]);
        const action = incidentMutation[2];
        const incident = this.store.getIncident(incidentId);
        if (!incident)
          throw new HttpError(404, "INCIDENT_NOT_FOUND", "Incident not found");
        if (action === "resolve") {
          const resolved = this.store.updateIncident(incidentId, {
            status: "resolved",
            lastAction: `resolved by ${actorName}`,
            resolved: true,
          });
          this.store.emit({
            incidentId,
            actorName,
            type: "ops.incident.resolved",
            phase: "ops",
            message: `Incident resolved by ${actorName}`,
          });
          json(response, 200, { ok: true, incident: resolved }, cors);
          return;
        }
        if (!this.ops)
          throw new HttpError(
            503,
            "OPS_NOT_RUNNING",
            "System Codex is not running",
          );
        const reopened = this.store.reopenIncident(incidentId);
        this.ops.queueIncident(
          reopened,
          `Manual diagnosis requested by ${actorName}`,
        );
        json(response, 202, { ok: true, incident: reopened }, cors);
        return;
      }

      if (request.method === "POST" && pathname === "/api/uploads") {
        const buffer = await readBuffer(request, this.config.uploadLimitBytes);
        if (!buffer.length)
          throw new HttpError(400, "EMPTY_UPLOAD", "Upload body is empty");
        const filename = safeFilename(request.headers["x-file-name"]);
        const diskName = `${crypto.randomUUID()}-${filename}`;
        const diskPath = path.join(this.config.uploadDirectory, diskName);
        fs.writeFileSync(diskPath, buffer, { flag: "wx" });
        const attachment = this.store.createAttachment({
          filename,
          path: diskPath,
          contentType:
            request.headers["content-type"] || "application/octet-stream",
          size: buffer.length,
          taskId: url.searchParams.get("taskId") || null,
          turnId: url.searchParams.get("turnId") || null,
        });
        json(response, 201, { ok: true, attachment }, cors);
        return;
      }

      const attachmentId = routeId(pathname, "/api/attachments/");
      if (
        attachmentId &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const attachment = this.store.getAttachment(attachmentId);
        if (!attachment)
          throw new HttpError(
            404,
            "ATTACHMENT_NOT_FOUND",
            "Attachment not found",
          );
        let stats;
        try {
          stats = fs.statSync(attachment.path);
        } catch {
          throw new HttpError(
            404,
            "ATTACHMENT_FILE_NOT_FOUND",
            "Attachment file not found",
          );
        }
        if (!stats.isFile())
          throw new HttpError(
            404,
            "ATTACHMENT_FILE_NOT_FOUND",
            "Attachment file not found",
          );
        const contentType = attachmentContentType(attachment.contentType);
        const headers = {
          "Content-Type": contentType,
          "Content-Length": stats.size,
          "Content-Disposition": attachmentDisposition(
            attachment.filename,
            INLINE_ATTACHMENT_TYPES.has(contentType),
          ),
          "Cache-Control": "private, max-age=300",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox",
          ...cors,
        };
        response.writeHead(200, headers);
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        const stream = fs.createReadStream(attachment.path);
        stream.on("error", () => response.destroy());
        stream.pipe(response);
        return;
      }

      if (request.method === "GET" && pathname === "/api/projects") {
        json(
          response,
          200,
          { ok: true, projects: this.store.listProjects() },
          cors,
        );
        return;
      }
      if (request.method === "GET" && pathname === "/api/build-dispatches") {
        json(
          response,
          200,
          {
            ok: true,
            dispatches: this.store.listBuildDispatches({
              status: url.searchParams.get("status") || null,
              limit: integer(url.searchParams.get("limit"), 250, 1, 1_000),
            }),
          },
          cors,
        );
        return;
      }
      if (request.method === "POST" && pathname === "/api/projects") {
        const body = await readJson(request, this.config.requestBodyLimitBytes);
        const project = this.store.createProject(projectInput(body), actorName);
        json(response, 201, { ok: true, project }, cors);
        return;
      }
      const projectId = routeId(pathname, "/api/projects/");
      if (projectId && request.method === "GET") {
        const project = this.store.getProject(projectId);
        if (!project)
          throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found");
        json(response, 200, { ok: true, project }, cors);
        return;
      }
      if (projectId && request.method === "PATCH") {
        const body = await readJson(request, this.config.requestBodyLimitBytes);
        json(
          response,
          200,
          {
            ok: true,
            project: this.store.updateProject(
              projectId,
              projectInput(body, true),
              actorName,
            ),
          },
          cors,
        );
        return;
      }
      if (projectId && request.method === "DELETE") {
        this.store.deleteProject(projectId, actorName);
        json(response, 200, { ok: true }, cors);
        return;
      }

      if (request.method === "GET" && pathname === "/api/workers") {
        json(
          response,
          200,
          { ok: true, workers: this.store.listWorkers() },
          cors,
        );
        return;
      }
      const workerUnityMcp = pathname.match(
        /^\/api\/workers\/([^/]+)\/unity-mcp$/,
      );
      if (workerUnityMcp) {
        if (!isLoopbackAddress(request.socket?.remoteAddress))
          throw new HttpError(
            403,
            "UNITY_MCP_LOOPBACK_REQUIRED",
            "The Relay UnitySkills MCP bridge is available only on loopback",
          );
        const worker = this.store.getWorker(
          decodeURIComponent(workerUnityMcp[1]),
        );
        if (!worker)
          throw new HttpError(404, "WORKER_NOT_FOUND", "Worker not found");
        const project = this.store.getProject(worker.projectId);
        if (!project)
          throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found");
        const baseUrl = resolveUnitySkillsBaseUrl(project, worker);
        if (!baseUrl)
          throw new HttpError(
            503,
            "UNITY_SKILLS_ENDPOINT_MISSING",
            "The Worker has no resolvable UnitySkills endpoint",
          );
        await handleUnitySkillsMcpRequest({ request, response, baseUrl });
        return;
      }
      if (request.method === "POST" && pathname === "/api/workers") {
        const body = await readJson(request, this.config.requestBodyLimitBytes);
        const worker = this.store.createWorker(workerInput(body), actorName);
        json(response, 201, { ok: true, worker }, cors);
        void this.scheduler.probeAll();
        return;
      }
      const workerAction = pathname.match(/^\/api\/workers\/([^/]+)\/action$/);
      if (workerAction && request.method === "POST") {
        const body = await readJson(request, this.config.requestBodyLimitBytes);
        const worker = await this.scheduler.controlWorker(
          decodeURIComponent(workerAction[1]),
          body.action,
          { force: Boolean(body.force), actorName },
        );
        json(response, 200, { ok: true, worker }, cors);
        return;
      }
      const workerId = routeId(pathname, "/api/workers/");
      if (workerId && request.method === "GET") {
        const worker = this.store.getWorker(workerId);
        if (!worker)
          throw new HttpError(404, "WORKER_NOT_FOUND", "Worker not found");
        json(response, 200, { ok: true, worker }, cors);
        return;
      }
      if (workerId && request.method === "PATCH") {
        const body = await readJson(request, this.config.requestBodyLimitBytes);
        json(
          response,
          200,
          {
            ok: true,
            worker: this.store.updateWorker(
              workerId,
              workerInput(body, true),
              actorName,
            ),
          },
          cors,
        );
        return;
      }
      if (workerId && request.method === "DELETE") {
        this.store.deleteWorker(workerId, actorName);
        json(response, 200, { ok: true }, cors);
        return;
      }

      if (request.method === "POST" && pathname === "/api/tasks") {
        const body = await readJson(request, this.config.requestBodyLimitBytes);
        const rawIdempotencyKey = request.headers["idempotency-key"];
        const idempotencyKey = Array.isArray(rawIdempotencyKey)
          ? rawIdempotencyKey[0]
          : rawIdempotencyKey;
        if (
          idempotencyKey &&
          (!/^[A-Za-z0-9._:-]+$/u.test(idempotencyKey) ||
            idempotencyKey.length > 200)
        ) {
          throw new HttpError(
            400,
            "INVALID_IDEMPOTENCY_KEY",
            "Idempotency-Key must be 1-200 safe ASCII characters",
          );
        }
        const message = requiredString(
          body.message ?? body.requirement,
          "message",
          { max: 100_000 },
        );
        const taskCodexSettings = codexTaskSettings(body, {
          codexModel: this.config.codexModel,
          codexReasoningEffort: this.config.codexReasoningEffort,
          codexFastMode: this.config.codexServiceTier === "fast",
        });
        const result = this.store.createTask({
          title: requiredString(body.title, "title", { max: 200 }),
          projectId: requiredString(body.projectId, "projectId", { max: 200 }),
          message,
          baseBranch:
            body.baseBranch == null
              ? undefined
              : gitRef(body.baseBranch, "baseBranch"),
          branchName:
            body.branchName == null
              ? undefined
              : gitRef(body.branchName, "branchName"),
          priority: integer(body.priority, 0, -100, 100),
          autoRelease: body.autoRelease !== false,
          executionProfile: executionProfile(body.executionProfile),
          ...taskCodexSettings,
          attachments: body.attachments || body.attachmentIds,
          idempotencyKey: idempotencyKey || null,
          userName: actorName,
        });
        this.scheduler.notifyQueueChanged();
        json(response, 201, { ok: true, ...result }, cors);
        return;
      }
      if (
        request.method === "POST" &&
        pathname === "/api/tasks/complete-batch"
      ) {
        if (!this.taskCompletionService) {
          throw new HttpError(
            503,
            "TASK_COMPLETION_DISABLED",
            "自动 MR 合并尚未启用",
          );
        }
        const body = await readJson(request, this.config.requestBodyLimitBytes);
        if (
          !Array.isArray(body.taskIds) ||
          body.taskIds.length === 0 ||
          body.taskIds.length > 50
        ) {
          throw new HttpError(
            400,
            "TASK_COMPLETION_BATCH_INVALID",
            "taskIds must contain 1-50 task IDs",
          );
        }
        const taskIds = body.taskIds.map((taskId, index) =>
          requiredString(taskId, `taskIds[${index}]`, { max: 200 }),
        );
        const result = await this.taskCompletionService.completeMany(
          taskIds,
          actorName,
        );
        json(
          response,
          result.failed ? 207 : 200,
          { ok: result.failed === 0, ...result },
          cors,
        );
        return;
      }
      const taskDetail = routeId(pathname, "/api/tasks/");
      if (taskDetail && request.method === "GET") {
        const task = this.store.getTask(taskDetail);
        if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
        json(
          response,
          200,
          {
            ok: true,
            task,
            turns: this.store.listTaskTurnsWithAttachments(taskDetail),
            events: this.store.listTaskEvents(taskDetail),
          },
          cors,
        );
        return;
      }
      const taskMutation = pathname.match(
        /^\/api\/tasks\/([^/]+)\/(messages|cancel|retry|resume-preserved|close|complete-relay-only|reopen)$/,
      );
      if (taskMutation && request.method === "POST") {
        const taskId = decodeURIComponent(taskMutation[1]);
        const action = taskMutation[2];
        if (action === "messages") {
          const body = await readJson(
            request,
            this.config.requestBodyLimitBytes,
          );
          const turn = this.store.appendTurn(taskId, {
            message: requiredString(
              body.message ?? body.requirement,
              "message",
              { max: 100_000 },
            ),
            priority:
              body.priority == null
                ? undefined
                : integer(body.priority, 0, -100, 100),
            attachments: body.attachments || body.attachmentIds,
            executionProfile: executionProfile(body.executionProfile),
            userName: actorName,
          });
          this.scheduler.notifyQueueChanged();
          json(response, 201, { ok: true, turn }, cors);
          return;
        }
        if (action === "cancel") {
          json(
            response,
            200,
            { ok: true, turn: this.scheduler.cancelTask(taskId, actorName) },
            cors,
          );
          return;
        }
        if (action === "retry") {
          json(
            response,
            201,
            { ok: true, turn: this.scheduler.retryTask(taskId, actorName) },
            cors,
          );
          return;
        }
        if (action === "resume-preserved") {
          const turn = this.store.rebindQueuedTurnToPreservedWorker(
            taskId,
            actorName,
          );
          this.scheduler.notifyQueueChanged();
          json(response, 200, { ok: true, turn }, cors);
          return;
        }
        if (action === "close") {
          if (!this.taskCompletionService) {
            throw new HttpError(
              503,
              "TASK_COMPLETION_DISABLED",
              "自动 MR 合并尚未启用",
            );
          }
          json(
            response,
            200,
            {
              ok: true,
              task: await this.taskCompletionService.complete(
                taskId,
                actorName,
              ),
            },
            cors,
          );
          return;
        }
        if (action === "complete-relay-only") {
          if (!this.taskCompletionService) {
            throw new HttpError(
              503,
              "TASK_COMPLETION_DISABLED",
              "任务完成服务尚未启用",
            );
          }
          json(
            response,
            200,
            {
              ok: true,
              task: await this.taskCompletionService.completeRelayOnly(
                taskId,
                actorName,
              ),
            },
            cors,
          );
          return;
        }
        if (action === "reopen") {
          json(
            response,
            200,
            { ok: true, task: this.store.reopenTask(taskId, actorName) },
            cors,
          );
          return;
        }
      }

      if (request.method === "POST" && pathname === "/api/scheduler/pause") {
        json(
          response,
          200,
          { ok: true, scheduler: this.scheduler.setPaused(true, actorName) },
          cors,
        );
        return;
      }
      if (request.method === "POST" && pathname === "/api/scheduler/resume") {
        json(
          response,
          200,
          { ok: true, scheduler: this.scheduler.setPaused(false, actorName) },
          cors,
        );
        return;
      }

      throw new HttpError(404, "NOT_FOUND", "API route not found");
    } catch (caught) {
      const error =
        caught instanceof HttpError
          ? caught
          : Object.assign(
              caught instanceof Error ? caught : new Error(String(caught)),
              {
                status: caught?.code?.startsWith?.("SQLITE_CONSTRAINT")
                  ? 409
                  : 500,
                code: caught?.code?.startsWith?.("SQLITE_CONSTRAINT")
                  ? "CONFLICT"
                  : caught?.code || "INTERNAL_ERROR",
              },
            );
      if ((error.status || 500) >= 500) console.error(error);
      const payload = errorPayload(error);
      json(
        response,
        error.status || 500,
        {
          ...payload,
          code: payload.error.code,
          message: payload.error.message,
        },
        cors,
      );
    }
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off("error", reject);
        resolve(this.server.address());
      });
    });
  }

  close() {
    this.unsubscribe?.();
    for (const client of this.sseClients) client.end();
    return new Promise((resolve) => this.server.close(resolve));
  }
}
