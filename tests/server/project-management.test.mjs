import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Store } from "../../server/db.mjs";
import { PipelineHttpServer } from "../../server/http.mjs";
import {
  isActionableProjectManagementDefect,
  ProjectManagementClient,
  projectManagementTaskKey,
  projectManagementTaskPrompt,
} from "../../server/project-management-client.mjs";

test("project-management defect status only keeps actionable work", () => {
  for (const status of ["新", "重新打开", "处理中", "待处理", "挂起"]) {
    assert.equal(
      isActionableProjectManagementDefect({ status }),
      true,
      `${status} should remain visible`,
    );
  }
  for (const status of [
    "已关闭",
    "已解决",
    "已完成",
    "已结束",
    "已验证",
    "已取消",
    "已拒绝",
  ]) {
    assert.equal(
      isActionableProjectManagementDefect({ status }),
      false,
      `${status} should be hidden`,
    );
  }
  assert.equal(
    isActionableProjectManagementDefect({
      status: "本地化名称未知",
      statusKey: "CLOSED",
    }),
    false,
  );
});

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function testPngBytes() {
  return Buffer.from("89504e470d0a1a0a0000000049454e44", "hex");
}

function responseSetCookies(responseValue) {
  if (typeof responseValue.headers.getSetCookie === "function") {
    return responseValue.headers.getSetCookie();
  }
  return String(responseValue.headers.get("set-cookie") || "")
    .split(/,(?=\s*relay-project-management-)/gu)
    .filter(Boolean);
}

function responseCookieHeader(responseValue) {
  return responseSetCookies(responseValue)
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

function responseCookie(responseHeaders, name) {
  const values = Array.isArray(responseHeaders["Set-Cookie"])
    ? responseHeaders["Set-Cookie"]
    : [responseHeaders["Set-Cookie"]];
  return values
    .map((value) => String(value || "").split(";", 1)[0])
    .find((value) => value.startsWith(`${name}=`));
}

test("project management client completes QR login and normalizes assigned defects", async () => {
  const calls = [];
  let rejectAuthentication = false;
  let defectResolved = false;
  let persistedState = null;
  const client = new ProjectManagementClient({
    baseUrl: "https://project.example.test",
    sessionStore: {
      async save(state) {
        persistedState = structuredClone(state);
      },
    },
    fetchImpl: async (url, options) => {
      calls.push({
        pathname: url.pathname,
        search: url.search,
        authorization: options.headers.Authorization || null,
        body: options.body ? JSON.parse(options.body) : null,
      });
      if (url.pathname === "/api/auth/qr/home-generate") {
        return response({
          code: 0,
          data: {
            qr_id: "qr-1",
            poll_token: "poll-1",
            qr_content: "light-app://login/qr-1",
          },
        });
      }
      if (url.pathname === "/api/auth/qr/home-status") {
        return response({
          code: 0,
          data: {
            status: 2,
            ticket: "ticket-1",
            phone: "13800000000",
          },
        });
      }
      if (url.pathname === "/api/auth/qr/exchange") {
        return response({
          code: 0,
          data: {
            token: "sensitive-upstream-token",
            user: { ID: 17, nickname: "测试用户" },
          },
        });
      }
      if (url.pathname === "/api/projects") {
        if (rejectAuthentication) {
          return response({ message: "expired" }, 401);
        }
        return response({
          code: 0,
          data: { list: [{ ID: 9, name: "OZDQP" }] },
        });
      }
      if (url.pathname === "/api/tasks" && url.search) {
        return response({
          code: 0,
          data: [
            {
              ID: 101,
              bug_no: "BUG-101",
              title: "鱼群按钮不响应",
              description: "点击按钮后没有反应",
              bug_status_name: "处理中",
              priority_name: "P1",
              severity_name: "严重",
              assignee: {
                nickname: "测试用户",
                avatar: "https://cdn.example.test/avatar.png",
              },
              project: {
                cover: "https://cdn.example.test/project-cover.png",
              },
              avatar_url: "https://cdn.example.test/flat-avatar.png",
              image_url: "https://cdn.example.test/default-task-image.png",
            },
          ],
          meta: { total: 1 },
        });
      }
      if (url.pathname === "/api/tasks/101") {
        return response({
          code: 0,
          data: {
            ID: 101,
            version: 7,
            project_id: 9,
            title: "鱼群按钮不响应",
            image_url: "https://cdn.example.test/default-task-image.png",
            description:
              '<p>完整复现步骤</p><img src="https://cdn.example.test/bug.png?token=first"><img src="https://cdn.example.test/bug.png?token=duplicate">',
            assignee: {
              nickname: "测试用户",
              avatar: "https://cdn.example.test/avatar.png",
            },
            avatar_url: "https://cdn.example.test/flat-avatar.png",
          },
        });
      }
      if (url.pathname === "/api/tasks/101/bug-transitions") {
        return response({
          code: 0,
          data: defectResolved
            ? []
            : [
                {
                  ID: 81,
                  required_fields: "resolve_version_id",
                  to_status: {
                    ID: 3,
                    status_key: "RESOLVED",
                    name: "已解决",
                  },
                },
              ],
          current_status: defectResolved
            ? { status_key: "RESOLVED", name: "已解决" }
            : { status_key: "IN_PROGRESS", name: "处理中" },
        });
      }
      if (url.pathname === "/api/versions") {
        return response({
          code: 0,
          data: [
            { ID: 44, name: "当前版本", status: "in_progress" },
            { ID: 45, name: "已归档版本", status: "completed" },
          ],
        });
      }
      if (
        url.pathname === "/api/tasks/101/bug-transition" &&
        options.method === "POST"
      ) {
        const body = JSON.parse(options.body);
        assert.deepEqual(body, {
          transition_id: 81,
          version: 7,
          resolve_version_id: 44,
        });
        defectResolved = true;
        return response({ code: 0, data: { ok: true } });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  const binding = {
    browserId: "browser-persistence-test",
    relayUserName: "Relay 测试用户",
  };
  const sessionId = client.createSession(binding);
  const started = await client.startLogin(sessionId);
  assert.equal(started.authenticated, false);
  assert.equal(started.login.qrContent, "light-app://login/qr-1");

  const authenticated = await client.pollLogin(sessionId);
  assert.equal(authenticated.authenticated, true);
  assert.deepEqual(authenticated.user, {
    id: "17",
    name: "测试用户",
    avatar: null,
  });
  assert.equal("token" in authenticated, false);
  assert.equal(persistedState.sessions.length, 1);
  assert.equal(persistedState.sessions[0].token, "sensitive-upstream-token");

  const restartedClient = new ProjectManagementClient({
    baseUrl: "https://project.example.test",
    fetchImpl: client.fetchImpl,
    initialSessionState: structuredClone(persistedState),
  });
  const restored = restartedClient.ensureSession(null, binding);
  assert.equal(restored.id, sessionId);
  assert.equal(restartedClient.publicSession(restored.id).authenticated, true);
  assert.equal(
    restartedClient.publicSession(restored.id).user.name,
    "测试用户",
  );

  const projects = await client.listProjects(sessionId);
  assert.deepEqual(projects, [{ id: "9", name: "OZDQP" }]);
  const listed = await client.listDefects(sessionId, {
    externalProjectId: "9",
  });
  assert.equal(listed.total, 1);
  assert.equal(listed.defects[0].code, "BUG-101");
  assert.equal(listed.defects[0].content, "完整复现步骤");
  assert.deepEqual(listed.defects[0].images, [
    "https://cdn.example.test/bug.png?token=first",
  ]);
  assert.equal(
    calls.filter((call) => call.pathname === "/api/tasks/101").length,
    1,
  );
  assert.match(
    calls.find((call) => call.pathname === "/api/tasks" && call.search).search,
    /assignee_id=17/u,
  );
  assert.ok(
    calls
      .filter((call) => call.pathname === "/api/projects")
      .every(
        (call) => call.authorization === "Bearer sensitive-upstream-token",
      ),
  );

  const completionBinding = client.completionBinding(sessionId);
  assert.deepEqual(completionBinding, {
    bindingKey: completionBinding.bindingKey,
    relayUserName: "Relay 测试用户",
    userId: "17",
    userName: "测试用户",
  });
  const bindingKey = completionBinding.bindingKey;
  const resolution = await client.resolveDefect(bindingKey, {
    defectId: "101",
    externalProjectId: "9",
    userId: "17",
    userName: "测试用户",
  });
  assert.deepEqual(resolution, {
    defectId: "101",
    status: "已解决",
    alreadyResolved: false,
  });
  const repeatedResolution = await client.resolveDefect(bindingKey, {
    defectId: "101",
    externalProjectId: "9",
    userId: "17",
    userName: "测试用户",
  });
  assert.equal(repeatedResolution.alreadyResolved, true);

  const authenticatedSession = client.sessions.get(sessionId);
  const originalUser = authenticatedSession.user;
  authenticatedSession.user = {
    id: "18",
    name: "另一个轻语账号",
    avatar: null,
  };
  const callsBeforeMismatch = calls.length;
  await assert.rejects(
    () =>
      client.resolveDefect(bindingKey, {
        defectId: "101",
        externalProjectId: "9",
        userId: "17",
        userName: "测试用户",
      }),
    { code: "PROJECT_MANAGEMENT_ACCOUNT_MISMATCH" },
  );
  assert.equal(calls.length, callsBeforeMismatch);
  authenticatedSession.user = originalUser;

  rejectAuthentication = true;
  await assert.rejects(() => client.listProjects(sessionId), {
    code: "PROJECT_MANAGEMENT_AUTH_REQUIRED",
  });
  assert.equal(client.publicSession(sessionId).authenticated, false);
  assert.deepEqual(persistedState.sessions, []);
});

test("project management images are downloaded with scoped authentication", async () => {
  const calls = [];
  const client = new ProjectManagementClient({
    baseUrl: "https://project.example.test",
    fetchImpl: async (url, options) => {
      calls.push({
        url: url.toString(),
        authorization: options.headers.Authorization || null,
        redirect: options.redirect,
      });
      if (url.origin === "https://project.example.test") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "https://cdn.example.test/signed/photo?expires=soon",
          },
        });
      }
      assert.equal(url.origin, "https://cdn.example.test");
      return new Response(testPngBytes(), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Disposition":
            "attachment; filename*=UTF-8''%E7%BC%BA%E9%99%B7%E7%85%A7%E7%89%87.png",
        },
      });
    },
  });
  const session = client.ensureSession(null, {
    browserId: "browser-image-test",
    relayUserName: "Relay 图片测试用户",
  });
  session.token = "sensitive-upstream-token";
  session.user = { id: "17", name: "轻语图片测试用户", avatar: null };

  const images = await client.downloadDefectImages(
    session.id,
    { images: ["https://project.example.test/protected/photo/1"] },
    { limitBytes: 1024 },
  );

  assert.equal(images.length, 1);
  assert.equal(images[0].filename, "缺陷照片.png");
  assert.equal(images[0].contentType, "image/png");
  assert.deepEqual(images[0].buffer, testPngBytes());
  assert.deepEqual(calls, [
    {
      url: "https://project.example.test/protected/photo/1",
      authorization: "Bearer sensitive-upstream-token",
      redirect: "manual",
    },
    {
      url: "https://cdn.example.test/signed/photo?expires=soon",
      authorization: null,
      redirect: "manual",
    },
  ]);
});

test("project management sessions are isolated by Relay user and browser", () => {
  const client = new ProjectManagementClient();
  const api = Object.create(PipelineHttpServer.prototype);
  api.projectManagementClient = client;

  const selectSession = (cookie) => {
    const responseHeaders = {};
    const id = api.projectManagementSession(
      { headers: { cookie, origin: "https://relay.example.test" } },
      responseHeaders,
    );
    return {
      id,
      responseHeaders,
      sessionCookie: responseCookie(
        responseHeaders,
        "relay-project-management-session",
      ),
      browserCookie: responseCookie(
        responseHeaders,
        "relay-project-management-browser",
      ),
    };
  };

  const alice = selectSession(`relay-user=${encodeURIComponent("用户甲")}`);
  assert.ok(alice.sessionCookie);
  assert.ok(alice.browserCookie);
  assert.ok(
    alice.responseHeaders["Set-Cookie"].every(
      (value) =>
        value.includes("HttpOnly") &&
        value.includes("SameSite=Lax") &&
        value.includes("Secure"),
    ),
  );
  const aliceSession = client.sessions.get(alice.id);
  aliceSession.token = "alice-token";
  aliceSession.user = { id: "101", name: "轻羽甲", avatar: null };

  const bob = selectSession(
    `${alice.sessionCookie}; ${alice.browserCookie}; relay-user=${encodeURIComponent("用户乙")}`,
  );
  assert.notEqual(bob.id, alice.id);
  assert.equal(client.publicSession(bob.id).authenticated, false);
  assert.equal(client.publicSession(bob.id).relayUserName, "用户乙");
  const bobSession = client.sessions.get(bob.id);
  bobSession.token = "bob-token";
  bobSession.user = { id: "102", name: "轻羽乙", avatar: null };

  const aliceAgain = selectSession(
    `${bob.sessionCookie}; ${bob.browserCookie}; relay-user=${encodeURIComponent("用户甲")}`,
  );
  assert.equal(aliceAgain.id, alice.id);
  assert.equal(client.publicSession(aliceAgain.id).user.name, "轻羽甲");
  assert.equal("token" in client.publicSession(aliceAgain.id), false);

  const aliceInAnotherBrowser = selectSession(
    `relay-user=${encodeURIComponent("用户甲")}`,
  );
  assert.notEqual(aliceInAnotherBrowser.id, alice.id);
  assert.equal(
    client.publicSession(aliceInAnotherBrowser.id).authenticated,
    false,
  );
});

function createConfig() {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-project-management-test-"),
  );
  return {
    version: "test",
    dataDirectory,
    databasePath: path.join(dataDirectory, "pipeline.sqlite"),
    uploadDirectory: path.join(dataDirectory, "uploads"),
    logDirectory: path.join(dataDirectory, "logs"),
    adapter: "test",
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: [],
    requestBodyLimitBytes: 2 * 1024 * 1024,
    uploadLimitBytes: 25 * 1024 * 1024,
    codexModel: "gpt-5.6-sol",
    codexReasoningEffort: "xhigh",
    codexServiceTier: "default",
  };
}

class FakeProjectManagementClient {
  constructor() {
    this.session = {
      id: "pm-session-test",
      user: { id: "17", name: "项目用户", avatar: null },
    };
    this.selection = null;
    this.includeInvalidDownloadedImage = false;
    this.defects = new Map([
      [
        "101",
        {
          id: "101",
          code: "BUG-101",
          title: "鱼群按钮不响应",
          content: "点击按钮后没有反应",
          status: "待处理",
          priority: "P1",
          severity: "严重",
          assignee: "项目用户",
          updatedAt: "2026-08-11T11:00:00Z",
          images: ["https://cdn.example.test/bug.png"],
          url: "https://project.example.test/tasks/101",
        },
      ],
      [
        "102",
        {
          id: "102",
          code: "BUG-102",
          title: "文本超出按钮",
          content: "窄屏时文本会溢出",
          status: "待处理",
          priority: "P2",
          severity: "一般",
          assignee: "项目用户",
          updatedAt: "2026-08-11T11:05:00Z",
          images: [],
          url: "https://project.example.test/tasks/102",
        },
      ],
      [
        "103",
        {
          id: "103",
          code: "BUG-103",
          title: "已经关闭的测试缺陷",
          content: "不应出现在列表，也不能创建任务",
          status: "已关闭",
          statusKey: "CLOSED",
          priority: "P2",
          severity: "一般",
          assignee: "项目用户",
          updatedAt: "2026-08-11T11:10:00Z",
          images: [],
          url: "https://project.example.test/tasks/103",
        },
      ],
    ]);
  }

  ensureSession() {
    return this.session;
  }

  publicSession() {
    return { authenticated: true, user: this.session.user, login: null };
  }

  completionBinding() {
    return {
      bindingKey: "a".repeat(64),
      relayUserName: "Relay 测试用户",
      userId: String(this.session.user.id),
      userName: this.session.user.name,
    };
  }

  async startLogin() {
    return this.publicSession();
  }

  async pollLogin() {
    return this.publicSession();
  }

  async logout() {
    return { authenticated: false, user: null, login: null };
  }

  async listProjects() {
    return [{ id: "9", name: "Test Unity Project" }];
  }

  selectedProject() {
    return this.selection;
  }

  rememberProject(_sessionId, _relayProjectId, externalProjectId) {
    this.selection = externalProjectId;
  }

  defectUrl(defectId) {
    return `https://project.example.test/tasks/${encodeURIComponent(defectId)}`;
  }

  async listDefects() {
    return {
      defects: [...this.defects.values()],
      total: this.defects.size,
      user: this.session.user,
    };
  }

  async getDefect(_sessionId, defectId) {
    const defect = this.defects.get(String(defectId));
    if (!defect)
      throw Object.assign(new Error("Defect not found"), { status: 404 });
    return defect;
  }

  async downloadDefectImages(_sessionId, defect) {
    const images = (defect.images || []).map((_url, index) => {
      const buffer = testPngBytes();
      return {
        filename: `轻语缺陷-${defect.id}-${index + 1}.png`,
        contentType: "image/png",
        size: buffer.length,
        buffer,
      };
    });
    if (this.includeInvalidDownloadedImage && images.length) {
      images.push({
        filename: "invalid.png",
        contentType: "image/png",
        size: 0,
        buffer: Buffer.alloc(0),
      });
    }
    return images;
  }
}

test("HTTP batch import creates one idempotent Relay task per selected defect", async (t) => {
  const config = createConfig();
  const store = new Store(config);
  const project = store.createProject({
    id: "project-test",
    name: "Test Unity Project",
    repoUrl: "https://example.invalid/test-unity.git",
    defaultBranch: "main",
    guestProjectPath: "D:\\Work\\test-unity",
    smbPath: "\\\\worker\\Work\\test-unity",
    checkpointName: "PROJECT_READY",
  });
  let queueNotifications = 0;
  const scheduler = {
    notifyQueueChanged() {
      queueNotifications += 1;
    },
    status() {
      return { running: true, paused: false, activeTurns: 0 };
    },
    runtimeStatus() {
      return null;
    },
  };
  const projectManagementClient = new FakeProjectManagementClient();
  const api = new PipelineHttpServer({
    config,
    store,
    scheduler,
    projectManagementClient,
  });
  const address = await api.listen();
  t.after(async () => {
    await api.close();
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${address.port}`;
  const origin = "http://localhost:3000";
  const relayUserCookie = `relay-user=${encodeURIComponent("Relay 测试用户")}`;

  const sessionResponse = await fetch(
    `${base}/api/project-management/session`,
    { headers: { Origin: origin, Cookie: relayUserCookie } },
  );
  assert.equal(sessionResponse.status, 200);
  assert.equal(
    sessionResponse.headers.get("access-control-allow-credentials"),
    "true",
  );
  assert.match(
    sessionResponse.headers.get("set-cookie") || "",
    /relay-project-management-session=.*HttpOnly/u,
  );
  assert.match(
    sessionResponse.headers.get("set-cookie") || "",
    /relay-project-management-browser=.*HttpOnly/u,
  );
  const cookie = `${relayUserCookie}; ${responseCookieHeader(sessionResponse)}`;

  const projectResponse = await fetch(
    `${base}/api/project-management/projects?relayProjectId=${project.id}`,
    { headers: { Cookie: cookie } },
  );
  assert.equal(projectResponse.status, 200);
  assert.equal((await projectResponse.json()).selectedProjectId, "9");

  const listBefore = await fetch(
    `${base}/api/project-management/defects?relayProjectId=${project.id}&externalProjectId=9`,
    { headers: { Cookie: cookie } },
  ).then((item) => item.json());
  assert.equal(listBefore.defects.length, 2);
  assert.equal(listBefore.total, 2);
  assert.ok(listBefore.defects.every((defect) => defect.status !== "已关闭"));
  assert.ok(listBefore.defects.every((defect) => defect.importedTask === null));

  const closedImport = await fetch(`${base}/api/project-management/import`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      projectId: project.id,
      externalProjectId: "9",
      items: [{ defectId: "103" }],
    }),
  }).then((item) => item.json());
  assert.equal(closedImport.created, 0);
  assert.equal(closedImport.failed, 1);
  assert.equal(
    closedImport.results[0].error.code,
    "PROJECT_MANAGEMENT_DEFECT_NOT_ACTIONABLE",
  );
  assert.equal(store.listTasks().length, 0);

  projectManagementClient.includeInvalidDownloadedImage = true;
  const invalidImageImport = await fetch(
    `${base}/api/project-management/import`,
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: project.id,
        externalProjectId: "9",
        items: [{ defectId: "101" }],
      }),
    },
  ).then((item) => item.json());
  assert.equal(invalidImageImport.created, 0);
  assert.equal(invalidImageImport.failed, 1);
  assert.equal(
    invalidImageImport.results[0].error.code,
    "PROJECT_MANAGEMENT_IMAGE_INVALID",
  );
  assert.equal(store.listTasks().length, 0);
  assert.deepEqual(fs.readdirSync(config.uploadDirectory), []);
  projectManagementClient.includeInvalidDownloadedImage = false;

  const imported = await fetch(`${base}/api/project-management/import`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      projectId: project.id,
      externalProjectId: "9",
      codexModel: "gpt-5.6-sol",
      codexReasoningEffort: "xhigh",
      executionProfile: "code_only",
      priority: 10,
      items: [
        { defectId: "101", extraPrompt: "重点验证移动端" },
        { defectId: "102" },
      ],
    }),
  });
  assert.equal(imported.status, 201);
  const importedPayload = await imported.json();
  assert.equal(importedPayload.created, 2);
  assert.equal(importedPayload.failed, 0);
  assert.equal(store.listTasks().length, 2);
  assert.equal(queueNotifications, 1);
  const firstTask = store.getTask(importedPayload.results[0].task.id);
  const firstTurn = store.listTaskTurns(firstTask.id)[0];
  assert.equal(firstTask.createdBy, "项目用户");
  assert.equal(firstTask.projectManagement?.defectId, "101");
  assert.equal(firstTask.projectManagement?.externalProjectId, "9");
  assert.equal(firstTask.projectManagement?.userId, "17");
  assert.equal(firstTask.projectManagement?.userName, "项目用户");
  assert.equal(firstTurn.executionProfile, "code_only");
  assert.match(firstTurn.userMessage, /鱼群按钮不响应/u);
  assert.match(firstTurn.userMessage, /重点验证移动端/u);
  assert.match(firstTurn.userMessage, /已下载并作为本轮图片附件提供（1 张）/u);
  assert.doesNotMatch(firstTurn.userMessage, /cdn\.example\.test/u);
  const firstTurnAttachments = store.listTurnAttachments(firstTurn.id);
  assert.equal(firstTurnAttachments.length, 1);
  assert.equal(firstTurnAttachments[0].filename, "轻语缺陷-101-1.png");
  assert.equal(firstTurnAttachments[0].contentType, "image/png");
  assert.deepEqual(
    fs.readFileSync(firstTurnAttachments[0].path),
    testPngBytes(),
  );
  assert.ok(firstTurnAttachments[0].path.startsWith(config.uploadDirectory));

  projectManagementClient.session.user = {
    id: "18",
    name: "另一个项目用户",
    avatar: null,
  };
  const repeated = await fetch(`${base}/api/project-management/import`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      externalProjectId: "9",
      items: [{ defectId: "101" }, { defectId: "102" }],
    }),
  }).then((item) => item.json());
  assert.equal(repeated.created, 0);
  assert.equal(repeated.duplicates, 2);
  assert.equal(store.listTasks().length, 2);
  assert.equal(queueNotifications, 1);
  const stillOriginalAccount = store.getTask(firstTask.id);
  assert.equal(stillOriginalAccount.projectManagement?.userId, "17");
  assert.equal(stillOriginalAccount.projectManagement?.userName, "项目用户");

  const listAfter = await fetch(
    `${base}/api/project-management/defects?relayProjectId=${project.id}&externalProjectId=9`,
    { headers: { Cookie: cookie } },
  ).then((item) => item.json());
  assert.ok(listAfter.defects.every((defect) => defect.importedTask?.id));
});

test("project management prompt and idempotency key are stable", () => {
  const defect = {
    id: "101",
    code: "BUG-101",
    title: "测试缺陷",
    content: "复现内容",
    images: ["https://cdn.example.test/protected.png?token=short-lived"],
    url: "https://project.example.test/tasks/101",
  };
  assert.equal(
    projectManagementTaskKey({
      relayProjectId: "relay-project",
      externalProjectId: "9",
      defectId: "101",
    }),
    projectManagementTaskKey({
      relayProjectId: "relay-project",
      externalProjectId: "9",
      defectId: "101",
    }),
  );
  const prompt = projectManagementTaskPrompt(defect, "补充验收");
  assert.match(prompt, /补充验收/u);
  assert.match(prompt, /已下载并作为本轮图片附件提供（1 张）/u);
  assert.doesNotMatch(prompt, /short-lived|cdn\.example\.test/u);
});
