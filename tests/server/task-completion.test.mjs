import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Store } from "../../server/db.mjs";
import { GitLabClient } from "../../server/gitlab-client.mjs";
import { PipelineHttpServer } from "../../server/http.mjs";
import { TaskCompletionService } from "../../server/task-completion-service.mjs";
import { HttpError } from "../../server/util.mjs";

const COMMIT_SHA = "a".repeat(40);
const MERGE_SHA = "b".repeat(40);
const ADVANCED_COMMIT_SHA = "c".repeat(40);

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-completion-test-"));
  const store = new Store({
    dataDirectory: root,
    databasePath: path.join(root, "pipeline.sqlite"),
    uploadDirectory: path.join(root, "uploads"),
    logDirectory: path.join(root, "logs"),
  });
  const project = store.createProject({
    id: "project-test",
    name: "Test project",
    repoUrl: "http://git.example.test/group/project.git",
    defaultBranch: "main",
    guestProjectPath: "D:\\Work\\project",
    smbPath: "\\\\worker\\Work\\project",
  });
  t.after(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { store, project };
}

function deliveredTask(store, projectId, { linked = false } = {}) {
  const created = store.createTask({
    projectId,
    title: linked ? "Linked defect" : "Relay task",
    message: "Complete the implementation",
    projectManagement: linked
      ? {
          externalProjectId: "9",
          defectId: "101",
          defectUrl: "https://project.example.test/tasks/101",
          relayUserName: "Relay user",
          userId: "17",
          userName: "Light user",
          bindingKey: "c".repeat(64),
        }
      : null,
  });
  store.db
    .prepare(
      "UPDATE turns SET status='success', commit_sha=?, finished_at=? WHERE id=?",
    )
    .run(COMMIT_SHA, new Date().toISOString(), created.turn.id);
  store.db
    .prepare(
      "UPDATE tasks SET status='waiting_user', latest_commit_sha=? WHERE id=?",
    )
    .run(COMMIT_SHA, created.task.id);
  return store.getTask(created.task.id);
}

function mergedResult(task) {
  return {
    iid: 12,
    webUrl: "http://git.example.test/group/project/-/merge_requests/12",
    sourceBranch: task.branchName,
    targetBranch: "main",
    mergedCommitSha: MERGE_SHA,
    alreadyMerged: false,
    sourceBranchDeleted: true,
  };
}

test("ordinary task closes only after its MR is confirmed merged", async (t) => {
  const { store, project } = createStore(t);
  const task = deliveredTask(store, project.id);
  const calls = [];
  const service = new TaskCompletionService({
    store,
    gitlabClient: {
      async ensureMerged(input) {
        calls.push({ step: "merge", input });
        return mergedResult(task);
      },
    },
    projectManagementClient: {
      async resolveDefect() {
        calls.push({ step: "project-management" });
      },
    },
  });

  const completed = await service.complete(task.id, "Reviewer");
  assert.equal(completed.status, "closed");
  assert.equal(completed.completion.status, "completed");
  assert.equal(completed.completion.mergeRequestIid, 12);
  assert.deepEqual(
    calls.map((call) => call.step),
    ["merge"],
    "ordinary tasks must skip project-management completion",
  );
  assert.equal(calls[0].input.targetBranch, "main");
  assert.equal("expectedSourceSha" in calls[0].input, false);
});

test("Relay-only completion skips GitLab and project-management side effects", async (t) => {
  const { store, project } = createStore(t);
  const task = deliveredTask(store, project.id, { linked: true });
  const service = new TaskCompletionService({
    store,
    gitlabClient: {
      async ensureMerged() {
        assert.fail("GitLab must not be called by Relay-only completion");
      },
    },
    projectManagementClient: {
      async resolveDefect() {
        assert.fail(
          "project management must not be called by Relay-only completion",
        );
      },
    },
  });

  const completed = await service.completeRelayOnly(task.id, "Reviewer");
  assert.equal(completed.status, "closed");
  assert.equal(completed.completion.status, "completed");
  assert.equal(completed.completion.step, "relay_only");
  assert.equal(completed.completion.mergeRequestIid, null);
  assert.equal(completed.projectManagement.resolvedAt, null);
  const closeEvent = store
    .listTaskEvents(task.id)
    .find((event) => event.data?.completionMode === "relay_only");
  assert.ok(closeEvent);
  assert.equal(closeEvent.data.mergeRequestSkipped, true);
  assert.equal(closeEvent.data.projectManagementSkipped, true);
});

test("linked task strictly merges, resolves the defect, then closes Relay", async (t) => {
  const { store, project } = createStore(t);
  const task = deliveredTask(store, project.id, { linked: true });
  const calls = [];
  const service = new TaskCompletionService({
    store,
    gitlabClient: {
      async ensureMerged() {
        calls.push("merge");
        assert.equal(store.getTask(task.id).status, "waiting_user");
        return mergedResult(task);
      },
    },
    projectManagementClient: {
      async resolveDefect(bindingKey, link) {
        calls.push("project-management");
        assert.equal(store.getTask(task.id).status, "waiting_user");
        assert.equal(bindingKey, "c".repeat(64));
        assert.deepEqual(link, {
          defectId: "101",
          externalProjectId: "9",
          userId: "17",
          userName: "Light user",
        });
        return {
          defectId: "101",
          status: "已解决",
          alreadyResolved: false,
        };
      },
    },
  });

  const completed = await service.complete(task.id, "Reviewer");
  calls.push("relay");
  assert.deepEqual(calls, ["merge", "project-management", "relay"]);
  assert.equal(completed.status, "closed");
  assert.equal(completed.projectManagement.resolvedAt != null, true);
  assert.equal(completed.completion.status, "completed");
  assert.deepEqual(
    store
      .listTaskEvents(task.id)
      .filter((event) => event.type.startsWith("task.completion"))
      .map((event) => event.type),
    [
      "task.completion.started",
      "task.completion.merge-succeeded",
      "task.completion.project-management-started",
      "task.completion.project-management-resolved",
    ],
  );
});

test("MR failure stops before project management and keeps Relay waiting", async (t) => {
  const { store, project } = createStore(t);
  const task = deliveredTask(store, project.id, { linked: true });
  let resolveCalls = 0;
  const service = new TaskCompletionService({
    store,
    gitlabClient: {
      async ensureMerged() {
        throw new HttpError(409, "GITLAB_MERGE_BLOCKED", "MR has conflicts");
      },
    },
    projectManagementClient: {
      async resolveDefect() {
        resolveCalls += 1;
      },
    },
  });

  await assert.rejects(() => service.complete(task.id), {
    code: "GITLAB_MERGE_BLOCKED",
  });
  const failed = store.getTask(task.id);
  assert.equal(resolveCalls, 0);
  assert.equal(failed.status, "waiting_user");
  assert.equal(failed.completion.status, "failed");
  assert.equal(failed.completion.step, "merge_request");
  assert.equal(failed.projectManagement.resolvedAt, null);
});

test("project-management failure stops after MR and retry resumes safely", async (t) => {
  const { store, project } = createStore(t);
  const task = deliveredTask(store, project.id, { linked: true });
  let mergeCalls = 0;
  let resolveCalls = 0;
  const service = new TaskCompletionService({
    store,
    gitlabClient: {
      async ensureMerged() {
        mergeCalls += 1;
        return { ...mergedResult(task), alreadyMerged: mergeCalls > 1 };
      },
    },
    projectManagementClient: {
      async resolveDefect() {
        resolveCalls += 1;
        if (resolveCalls === 1) {
          throw new HttpError(
            409,
            "PROJECT_MANAGEMENT_RESOLVE_TRANSITION_UNAVAILABLE",
            "No resolved transition",
          );
        }
        return {
          defectId: "101",
          status: "已解决",
          alreadyResolved: false,
        };
      },
    },
  });

  await assert.rejects(() => service.complete(task.id), {
    code: "PROJECT_MANAGEMENT_RESOLVE_TRANSITION_UNAVAILABLE",
  });
  let persisted = store.getTask(task.id);
  assert.equal(persisted.status, "waiting_user");
  assert.equal(persisted.completion.status, "failed");
  assert.equal(persisted.completion.step, "project_management");
  assert.equal(persisted.completion.mergeRequestIid, 12);

  persisted = await service.complete(task.id);
  assert.equal(mergeCalls, 2);
  assert.equal(resolveCalls, 2);
  assert.equal(persisted.status, "closed");
  assert.equal(persisted.completion.status, "completed");
});

test("batch completion is serial and continues after an individual failure", async (t) => {
  const { store, project } = createStore(t);
  const first = deliveredTask(store, project.id);
  const second = deliveredTask(store, project.id);
  const third = deliveredTask(store, project.id);
  const calls = [];
  const service = new TaskCompletionService({
    store,
    gitlabClient: {
      async ensureMerged(input) {
        calls.push(input.sourceBranch);
        if (input.sourceBranch === second.branchName) {
          throw new HttpError(409, "GITLAB_MERGE_BLOCKED", "MR has conflicts");
        }
        const task = [first, second, third].find(
          (candidate) => candidate.branchName === input.sourceBranch,
        );
        return mergedResult(task);
      },
    },
  });

  const result = await service.completeMany(
    [first.id, second.id, third.id],
    "Reviewer",
  );
  assert.deepEqual(calls, [
    first.branchName,
    second.branchName,
    third.branchName,
  ]);
  assert.equal(result.total, 3);
  assert.equal(result.completed, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(
    result.results.map((item) => item.status),
    ["completed", "failed", "completed"],
  );
  assert.equal(store.getTask(first.id).status, "closed");
  assert.equal(store.getTask(second.id).status, "waiting_user");
  assert.equal(store.getTask(third.id).status, "closed");
});

test("HTTP batch completion accepts one request and returns per-task results", async (t) => {
  const { store } = createStore(t);
  const calls = [];
  const api = new PipelineHttpServer({
    config: {
      version: "test",
      adapter: "test",
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: [],
      requestBodyLimitBytes: 1024 * 1024,
    },
    store,
    scheduler: {},
    taskCompletionService: {
      async completeMany(taskIds, actorName) {
        calls.push({ taskIds, actorName });
        return {
          total: 2,
          completed: 1,
          failed: 1,
          results: [
            { taskId: taskIds[0], number: 1, status: "completed" },
            {
              taskId: taskIds[1],
              number: 2,
              status: "failed",
              error: { code: "GITLAB_MERGE_BLOCKED", message: "conflict" },
            },
          ],
        };
      },
    },
  });
  const address = await api.listen();
  t.after(() => api.close());

  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/tasks/complete-batch`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pipeline-User": "Batch reviewer",
      },
      body: JSON.stringify({ taskIds: ["task-a", "task-b"] }),
    },
  );
  assert.equal(response.status, 207);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.completed, 1);
  assert.equal(payload.failed, 1);
  assert.deepEqual(calls, [
    {
      taskIds: ["task-a", "task-b"],
      actorName: "Batch reviewer",
    },
  ]);
});

test("HTTP Relay-only completion uses the bypass path explicitly", async (t) => {
  const { store } = createStore(t);
  const calls = [];
  const api = new PipelineHttpServer({
    config: {
      version: "test",
      adapter: "test",
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: [],
      requestBodyLimitBytes: 1024 * 1024,
    },
    store,
    scheduler: {},
    taskCompletionService: {
      async completeRelayOnly(taskId, actorName) {
        calls.push({ taskId, actorName });
        return { id: taskId, status: "closed" };
      },
    },
  });
  const address = await api.listen();
  t.after(() => api.close());

  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/tasks/task-a/complete-relay-only`,
    {
      method: "POST",
      headers: { "X-Pipeline-User": "Relay reviewer" },
    },
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.task.status, "closed");
  assert.deepEqual(calls, [{ taskId: "task-a", actorName: "Relay reviewer" }]);
});

test("GitLab client merges the current branch head without enforcing a recorded SHA", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-gitlab-test-"));
  const tokenFile = path.join(root, "token.txt");
  fs.writeFileSync(tokenFile, "glpat-test-token-value", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let referenceCalls = 0;
  let sourceBranchExists = true;
  const client = new GitLabClient({
    baseUrl: "http://git.example.test",
    tokenFile,
    fetchImpl: async (url, options) => {
      calls.push({
        pathname: url.pathname,
        search: url.search,
        method: options.method,
        token: options.headers["PRIVATE-TOKEN"],
        body: options.body ? JSON.parse(options.body) : null,
      });
      if (url.pathname.endsWith("/projects/group%2Fproject")) {
        return response({ id: 30, default_branch: "main" });
      }
      if (url.pathname.includes("/repository/branches/")) {
        const branch = decodeURIComponent(url.pathname.split("/").at(-1));
        if (options.method === "DELETE") {
          sourceBranchExists = false;
          return new Response(null, { status: 204 });
        }
        if (branch !== "main" && !sourceBranchExists) {
          return response({ message: "404 Branch Not Found" }, 404);
        }
        return response({
          name: branch,
          commit: { id: branch === "main" ? "d".repeat(40) : COMMIT_SHA },
        });
      }
      if (url.pathname.endsWith(`/repository/commits/${COMMIT_SHA}/refs`)) {
        referenceCalls += 1;
        return response(
          referenceCalls === 1 ? [] : [{ type: "branch", name: "main" }],
        );
      }
      if (
        url.pathname.endsWith("/merge_requests") &&
        options.method === "GET"
      ) {
        return response([]);
      }
      if (
        url.pathname.endsWith("/merge_requests") &&
        options.method === "POST"
      ) {
        return response(
          {
            iid: 12,
            state: "opened",
            sha: COMMIT_SHA,
            web_url:
              "http://git.example.test/group/project/-/merge_requests/12",
          },
          201,
        );
      }
      if (
        url.pathname.endsWith("/merge_requests/12") &&
        options.method === "GET"
      ) {
        return response({
          iid: 12,
          state: "opened",
          sha: COMMIT_SHA,
          detailed_merge_status: "mergeable",
        });
      }
      if (
        url.pathname.endsWith("/merge_requests/12/merge") &&
        options.method === "PUT"
      ) {
        return response({
          iid: 12,
          state: "merged",
          sha: COMMIT_SHA,
          merged_at: "2026-08-12T03:00:00Z",
          merge_commit_sha: MERGE_SHA,
          web_url: "http://git.example.test/group/project/-/merge_requests/12",
        });
      }
      throw new Error(`Unexpected GitLab request: ${options.method} ${url}`);
    },
  });

  const merged = await client.ensureMerged({
    repositoryUrl: "http://git.example.test/group/project.git",
    sourceBranch: "codex/task-0001-example",
    targetBranch: "main",
    expectedSourceSha: ADVANCED_COMMIT_SHA,
    title: "Relay task",
    description: "Automated merge",
  });
  assert.equal(merged.iid, 12);
  assert.equal(merged.mergedCommitSha, MERGE_SHA);
  assert.equal(merged.alreadyMerged, false);
  assert.equal(merged.sourceBranchDeleted, true);
  assert.ok(calls.every((call) => call.token === "glpat-test-token-value"));
  assert.deepEqual(
    calls.find(
      (call) =>
        call.pathname.endsWith("/merge_requests/12/merge") &&
        call.method === "PUT",
    ).body,
    {
      should_remove_source_branch: true,
      merge_when_pipeline_succeeds: false,
      squash: false,
    },
  );
  assert.equal(
    calls.find(
      (call) =>
        call.pathname.includes("/repository/branches/") &&
        call.method === "DELETE",
    ).method,
    "DELETE",
  );
  assert.equal(
    calls.find(
      (call) =>
        call.pathname.endsWith("/merge_requests") && call.method === "POST",
    ).body.remove_source_branch,
    true,
  );
  assert.equal(referenceCalls, 2);
});

test("GitLab client deletes a matching residual source branch for an already merged MR", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-gitlab-cleanup-test-"),
  );
  const tokenFile = path.join(root, "token.txt");
  fs.writeFileSync(tokenFile, "glpat-test-token-value", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let sourceBranchExists = true;
  const client = new GitLabClient({
    baseUrl: "http://git.example.test",
    tokenFile,
    fetchImpl: async (url, options) => {
      calls.push({ pathname: url.pathname, method: options.method });
      if (url.pathname.endsWith("/projects/group%2Fproject")) {
        return response({ id: 30, default_branch: "main" });
      }
      if (url.pathname.endsWith("/merge_requests")) {
        return response([
          {
            iid: 12,
            state: "merged",
            sha: COMMIT_SHA,
            merge_commit_sha: MERGE_SHA,
            web_url:
              "http://git.example.test/group/project/-/merge_requests/12",
          },
        ]);
      }
      if (url.pathname.endsWith(`/repository/commits/${COMMIT_SHA}/refs`)) {
        return response([{ type: "branch", name: "main" }]);
      }
      if (url.pathname.includes("/repository/branches/")) {
        const branch = decodeURIComponent(url.pathname.split("/").at(-1));
        if (branch === "main") {
          return response({ name: branch, commit: { id: "d".repeat(40) } });
        }
        if (options.method === "DELETE") {
          sourceBranchExists = false;
          return new Response(null, { status: 204 });
        }
        return sourceBranchExists
          ? response({ name: branch, commit: { id: COMMIT_SHA } })
          : response({ message: "404 Branch Not Found" }, 404);
      }
      throw new Error(`Unexpected GitLab request: ${options.method} ${url}`);
    },
  });

  const merged = await client.ensureMerged({
    repositoryUrl: "http://git.example.test/group/project.git",
    sourceBranch: "codex/task-0001-example",
    targetBranch: "main",
    expectedSourceSha: COMMIT_SHA,
    title: "Relay task",
    description: "Automated merge",
  });
  assert.equal(merged.alreadyMerged, true);
  assert.equal(merged.sourceBranchDeleted, true);
  assert.equal(sourceBranchExists, false);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
});

test("GitLab client accepts a manually merged MR after its source branch was deleted", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-gitlab-manual-merge-test-"),
  );
  const tokenFile = path.join(root, "token.txt");
  fs.writeFileSync(tokenFile, "glpat-test-token-value", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = new GitLabClient({
    baseUrl: "http://git.example.test",
    tokenFile,
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("/projects/group%2Fproject")) {
        return response({ id: 30, default_branch: "main" });
      }
      if (url.pathname.endsWith("/merge_requests")) {
        return response([
          {
            iid: 12,
            state: "merged",
            sha: COMMIT_SHA,
            merge_commit_sha: MERGE_SHA,
            web_url:
              "http://git.example.test/group/project/-/merge_requests/12",
          },
        ]);
      }
      if (url.pathname.endsWith(`/repository/commits/${MERGE_SHA}/refs`)) {
        return response([{ type: "branch", name: "main" }]);
      }
      if (url.pathname.includes("/repository/branches/")) {
        const branch = decodeURIComponent(url.pathname.split("/").at(-1));
        return branch === "main"
          ? response({ name: branch, commit: { id: MERGE_SHA } })
          : response({ message: "404 Branch Not Found" }, 404);
      }
      throw new Error(`Unexpected GitLab request: ${url}`);
    },
  });

  const merged = await client.ensureMerged({
    repositoryUrl: "http://git.example.test/group/project.git",
    sourceBranch: "codex/task-0001-example",
    targetBranch: "main",
    title: "Relay task",
    description: "Manual merge reconciliation",
  });
  assert.equal(merged.iid, 12);
  assert.equal(merged.mergedCommitSha, MERGE_SHA);
  assert.equal(merged.alreadyMerged, true);
  assert.equal(merged.sourceBranchDeleted, true);
});

test("GitLab client preserves a source branch that advances after merge verification", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-gitlab-drift-test-"),
  );
  const tokenFile = path.join(root, "token.txt");
  fs.writeFileSync(tokenFile, "glpat-test-token-value", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let deleteCalls = 0;
  let sourceBranchReads = 0;
  const client = new GitLabClient({
    baseUrl: "http://git.example.test",
    tokenFile,
    fetchImpl: async (url, options) => {
      if (url.pathname.endsWith("/projects/group%2Fproject")) {
        return response({ id: 30, default_branch: "main" });
      }
      if (url.pathname.endsWith("/merge_requests")) {
        return response([
          {
            iid: 12,
            state: "merged",
            sha: COMMIT_SHA,
            merge_commit_sha: MERGE_SHA,
          },
        ]);
      }
      if (url.pathname.endsWith(`/repository/commits/${COMMIT_SHA}/refs`)) {
        return response([{ type: "branch", name: "main" }]);
      }
      if (url.pathname.includes("/repository/branches/")) {
        const branch = decodeURIComponent(url.pathname.split("/").at(-1));
        if (options.method === "DELETE") {
          deleteCalls += 1;
          return new Response(null, { status: 204 });
        }
        if (branch === "main") {
          return response({ name: branch, commit: { id: "d".repeat(40) } });
        }
        sourceBranchReads += 1;
        return response({
          name: branch,
          commit: {
            id: sourceBranchReads === 1 ? COMMIT_SHA : ADVANCED_COMMIT_SHA,
          },
        });
      }
      throw new Error(`Unexpected GitLab request: ${options.method} ${url}`);
    },
  });

  const merged = await client.ensureMerged({
    repositoryUrl: "http://git.example.test/group/project.git",
    sourceBranch: "codex/task-0001-example",
    targetBranch: "main",
    title: "Relay task",
    description: "Automated merge",
  });
  assert.equal(merged.alreadyMerged, true);
  assert.equal(merged.sourceBranchDeleted, false);
  assert.equal(deleteCalls, 0);
});

test("GitLab token is never sent to a repository on another host", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-gitlab-host-test-"),
  );
  const tokenFile = path.join(root, "token.txt");
  fs.writeFileSync(tokenFile, "glpat-test-token-value", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let fetchCalls = 0;
  const client = new GitLabClient({
    baseUrl: "http://git.example.test",
    tokenFile,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("fetch must not be called");
    },
  });

  await assert.rejects(
    () =>
      client.ensureMerged({
        repositoryUrl: "https://untrusted.example/group/project.git",
        sourceBranch: "codex/task-0001-example",
        targetBranch: "main",
        expectedSourceSha: COMMIT_SHA,
        title: "Relay task",
        description: "Automated merge",
      }),
    { code: "GITLAB_REPOSITORY_HOST_NOT_ALLOWED" },
  );
  assert.equal(fetchCalls, 0);
});
