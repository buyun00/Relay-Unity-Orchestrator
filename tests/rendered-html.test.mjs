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
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("starter preview is removed and the product shell is durable", async () => {
  const [page, layout, controlDesk, css, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/control-desk.tsx", import.meta.url), "utf8"),
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
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /--signal:\s*#72e0b2/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(
    access(
      new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url),
    ),
  );
});
