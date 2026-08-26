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
  assert.match(html, /当前工位池/);
  assert.match(html, /监督工作树/);
  assert.match(html, /Relay 自动监控/);
  assert.match(html, /系统事件/);
  assert.doesNotMatch(html, />系统助手</);
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
  assert.match(controlDesk, /MonitorWorktree/);
  assert.match(controlDesk, /监督工作树/);
  assert.match(controlDesk, /Luna Max 常驻监督/);
  assert.match(controlDesk, /Sol xhigh 修复分支/);
  assert.match(controlDesk, /任务出错/);
  assert.match(controlDesk, /错误已解决/);
  assert.doesNotMatch(controlDesk, /view: "ops", label: "系统助手"/);
  assert.match(controlDesk, /function SystemPage/);
  assert.match(controlDesk, /系统与环境/);
  assert.match(controlDesk, /当前宿主机性能/);
  assert.match(controlDesk, /每 3 秒刷新/);
  assert.match(controlDesk, /GPU 温度回退/);
  assert.match(controlDesk, /HostDiskCapacityBar/);
  assert.match(controlDesk, /固定磁盘容量分段/);
  assert.match(controlDesk, /usagePercent > 80/);
  assert.match(controlDesk, /系统页面分区/);
  assert.match(controlDesk, /requestedView.*workers.*projects.*settings/s);
  assert.doesNotMatch(controlDesk, /view: "workers", label: "工位"/);
  assert.doesNotMatch(controlDesk, /view: "projects", label: "项目"/);
  assert.doesNotMatch(controlDesk, /view: "settings", label: "系统"/);
  assert.match(controlDesk, /GPT-5\.6 Luna/);
  assert.match(controlDesk, /全权限修复/);
  assert.match(controlDesk, /不可变归档/);
  assert.match(controlDesk, /初始提示词/);
  assert.match(controlDesk, /TurnAttachments/);
  assert.match(controlDesk, /\/api\/attachments\//);
  assert.match(controlDesk, /本轮附件，共/);
  assert.match(controlDesk, /自动判断（代码优先）/);
  assert.match(controlDesk, /仅代码/);
  assert.match(controlDesk, /Unity 资源 \/ Prefab/);
  assert.match(controlDesk, /第二轮及后续提示词也支持直接粘贴截图/);
  assert.match(controlDesk, /onPaste=\{pasteImages\}/);
  assert.match(css, /\.turn-attachment-grid/);
  assert.match(controlDesk, /aria-live="polite"/);
  assert.match(css, /\.monitor-worktree-panel/);
  assert.match(css, /\.monitor-repair-branch/);
  assert.match(css, /\.dashboard-worker-pool \.worker-node-list/);
  assert.match(css, /\.system-hub-section/);
  assert.match(css, /\.system-hub-nav/);
  assert.match(css, /\.host-performance-grid/);
  assert.match(css, /\.host-disk-capacity-bar/);
  assert.match(css, /\.host-disk-volume\.danger/);
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
  assert.match(apiClient, /fetchHostMetrics/);
  assert.match(apiClient, /!\["GET", "HEAD", "OPTIONS"\]\.includes\(method\)/);
  assert.match(webServer, /controlProxyPrefix = "\/relay-control"/);
  assert.match(webServer, /"\/_relay\/host-metrics"/);
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
