import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server renders the Relay control desk", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Relay · Unity 自动化调度台<\/title>/i);
  assert.match(html, /Unity 调度台/);
  assert.match(html, /发起任务/);
  assert.match(html, /实时任务轨道/);
  assert.match(html, /工位池/);
  assert.match(html, /系统助手/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("starter preview is removed and the product shell is durable", async () => {
  const [page, layout, controlDesk, apiClient, webServer, css, packageJson] =
    await Promise.all([
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/control-desk.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/api.ts", import.meta.url), "utf8"),
      readFile(new URL("../server/web.mjs", import.meta.url), "utf8"),
      readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
    ]);
  assert.match(page, /<ControlDesk \/>/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(controlDesk, /追加一轮/);
  assert.match(controlDesk, /现场已保留/);
  assert.match(controlDesk, /同一任务|持久对话|Codex thread/);
  assert.match(controlDesk, /codex\.agent_message/);
  assert.match(controlDesk, /Codex 进度消息/);
  assert.match(controlDesk, /Codex 配置/);
  assert.match(controlDesk, /GPT-5\.6 Sol/);
  assert.match(controlDesk, /Extra High/);
  assert.match(controlDesk, /Fast 模式/);
  assert.match(controlDesk, /CONVERSATIONS/);
  assert.match(controlDesk, /onCreateThread/);
  assert.match(controlDesk, /onUpdateThread/);
  assert.match(controlDesk, /onClearThread/);
  assert.match(controlDesk, /自动事故处理/);
  assert.match(controlDesk, /发送给系统 Codex/);
  assert.match(controlDesk, /交给系统 Codex/);
  assert.match(controlDesk, /消息已接收，正在等待 System Codex 开始/);
  assert.match(controlDesk, /System Codex 正在思考和处理/);
  assert.match(controlDesk, /本轮已结束，System Codex 当前已停止/);
  assert.match(controlDesk, /aria-live="polite"/);
  assert.match(css, /@keyframes ops-activity-progress/);
  assert.match(controlDesk, /输入使用者名称/);
  assert.match(controlDesk, /identityReady && identityOpen/);
  assert.match(controlDesk, /connectionChecked && !connected/);
  assert.match(controlDesk, /正在连接/);
  assert.match(controlDesk, /refreshInFlight\.current/);
  assert.match(controlDesk, /fetchSnapshot\(controller\.signal\)/);
  assert.doesNotMatch(controlDesk, /管理令牌/);
  assert.match(apiClient, /X-Pipeline-User/);
  assert.match(apiClient, /window\.location\.origin\}\$\{HTTPS_API_PREFIX\}/);
  assert.match(apiClient, /HTTPS_API_PREFIX = "\/relay-control"/);
  assert.match(apiClient, /!\["GET", "HEAD", "OPTIONS"\]\.includes\(method\)/);
  assert.match(webServer, /controlProxyPrefix = "\/relay-control"/);
  assert.match(webServer, /"x-relay-control-proxy"/);
  assert.match(webServer, /"x-relay-guardian-proxy"/);
  assert.match(webServer, /guardianPort/);
  assert.doesNotMatch(apiClient, /relay-admin-token|Authorization/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /--signal:\s*#72e0b2/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(
    access(
      new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url),
    ),
  );
});
