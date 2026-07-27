import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { BuildDispatcher } from "../../server/build-dispatcher.mjs";
import { Store } from "../../server/db.mjs";
import {
  OzdqpBuildClient,
  OzdqpBuildClientError,
} from "../../server/ozdqp-build-client.mjs";

const REPOSITORY_URL = "http://git.dominogm.com/diaoyu/ozdqp.git";
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

function createConfig(overrides = {}) {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-ozdqp-build-test-"),
  );
  return {
    dataDirectory,
    databasePath: path.join(dataDirectory, "pipeline.sqlite"),
    uploadDirectory: path.join(dataDirectory, "uploads"),
    logDirectory: path.join(dataDirectory, "logs"),
    ozdqpBuildEnabled: true,
    ozdqpBuildRepositoryUrl: REPOSITORY_URL,
    ...overrides,
  };
}

function seedTurn(
  store,
  {
    autoBuildEnabled = true,
    buildProjectKey = "ozdqp",
    repoUrl = REPOSITORY_URL,
  } = {},
) {
  const project = store.createProject({
    id: "project-ozdqp",
    name: "ozdqp",
    repoUrl,
    defaultBranch: "main",
    guestProjectPath: "D:\\ozdqp",
    smbPath: "\\\\10.100.3.209\\ozdqp",
    checkpointName: "PROJECT_READY",
    autoBuildEnabled,
    buildProjectKey,
  });
  const worker = store.createWorker({
    id: "worker-ozdqp",
    name: "ozdqp-build-worker",
    vmName: "ozdqp-build-worker",
    projectId: project.id,
    sharePath: project.smbPath,
    status: "ready",
  });
  const created = store.createTask({
    projectId: project.id,
    title: "Build integration",
    message: "Deliver this turn",
  });
  const context = store.claimNextTurn();
  assert.equal(context.turn.id, created.turn.id);
  return { ...created, project, worker, context };
}

function delivery(overrides = {}) {
  return {
    commitSha: COMMIT_SHA,
    remoteSha: COMMIT_SHA,
    pushed: true,
    verified: true,
    ...overrides,
  };
}

function complete(store, turnId, proof = delivery()) {
  return store.completeTurn(turnId, {
    codexFinal: { status: "completed", summary: "Delivered" },
    commitSha: proof.commitSha,
    delivery: proof,
  });
}

async function waitUntil(predicate, description, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function sampleDispatch(overrides = {}) {
  return {
    projectKey: "ozdqp",
    repositoryUrl: REPOSITORY_URL,
    branchName: "codex/task-0017-example",
    commitSha: COMMIT_SHA,
    modules: ["all"],
    playerBaseVersion: 1,
    requestedBy: {
      system: "relay-unity-orchestrator",
      projectId: "project-1",
      taskId: "task-1",
      taskNumber: 17,
      turnId: "turn-1",
      turnSequence: 2,
    },
    idempotencyKey: `relay:turn-1:${COMMIT_SHA}`,
    ...overrides,
  };
}

test("client sends the Relay envelope, stable idempotency key, and optional API key", async () => {
  const calls = [];
  const client = new OzdqpBuildClient({
    endpoint: "http://packer.invalid/api/v1/builds",
    apiKey: "test-api-key",
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify({
          job: { jobId: "job-accepted" },
          deduplicated: false,
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const result = await client.submit(sampleDispatch());
  assert.deepEqual(result, {
    jobId: "job-accepted",
    status: 202,
    deduplicated: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["X-OZDQP-API-Key"], "test-api-key");
  assert.equal(
    calls[0].options.headers["Idempotency-Key"],
    `relay:turn-1:${COMMIT_SHA}`,
  );
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.projectKey, "ozdqp");
  assert.equal(payload.repository.url, REPOSITORY_URL);
  assert.equal(payload.repository.branch, "codex/task-0017-example");
  assert.equal(payload.repository.commitSha, COMMIT_SHA);
  assert.equal(payload.buildType, "cdn");
  assert.equal(payload.mode, "cdn");
  assert.deepEqual(payload.modules, ["all"]);
  assert.equal(payload.playerBaseVersion, 1);
  assert.equal(payload.requestedBy.turnSequence, 2);
  assert.equal(Object.hasOwn(payload.repository, "baseBranch"), false);
});

test("client classifies retryable, permanent, and authentication HTTP responses without response bodies", async (t) => {
  const cases = [
    {
      status: 503,
      code: "OZDQP_HTTP_RETRYABLE",
      retryable: true,
      retryAfterMs: 2_000,
    },
    {
      status: 422,
      code: "OZDQP_HTTP_PERMANENT",
      retryable: false,
      retryAfterMs: null,
    },
    {
      status: 403,
      code: "OZDQP_AUTH_CONFIGURATION_ERROR",
      retryable: false,
      retryAfterMs: null,
    },
  ];
  for (const expected of cases) {
    await t.test(`HTTP ${expected.status}`, async () => {
      const client = new OzdqpBuildClient({
        endpoint: "http://packer.invalid/api/v1/builds",
        fetcher: async () =>
          new Response('{"error":"sensitive upstream detail"}', {
            status: expected.status,
            headers:
              expected.status === 503 ? { "Retry-After": "2" } : undefined,
          }),
      });
      await assert.rejects(
        () => client.submit(sampleDispatch()),
        (error) => {
          assert.ok(error instanceof OzdqpBuildClientError);
          assert.equal(error.code, expected.code);
          assert.equal(error.status, expected.status);
          assert.equal(error.retryable, expected.retryable);
          assert.equal(error.retryAfterMs, expected.retryAfterMs);
          assert.doesNotMatch(error.message, /sensitive upstream detail/u);
          return true;
        },
      );
    });
  }
});

test("completeTurn atomically persists turn.delivered and one eligible outbox record", (t) => {
  const config = createConfig();
  const store = new Store(config);
  t.after(() => {
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  });
  const { context } = seedTurn(store);
  const observed = [];
  store.onEvent((event) => observed.push(event.type));

  complete(store, context.turn.id);
  const persisted = store.getBuildDispatchForTurn(context.turn.id);
  assert.equal(store.getTurn(context.turn.id).status, "success");
  assert.equal(persisted.status, "pending");
  assert.equal(persisted.projectKey, "ozdqp");
  assert.equal(persisted.repositoryUrl, REPOSITORY_URL);
  assert.equal(persisted.branchName, context.task.branchName);
  assert.notEqual(persisted.branchName, context.task.baseBranch);
  assert.equal(persisted.commitSha, COMMIT_SHA);
  assert.equal(
    persisted.idempotencyKey,
    `relay:${context.turn.id}:${COMMIT_SHA}`,
  );
  assert.deepEqual(persisted.requestedBy, {
    system: "relay-unity-orchestrator",
    projectId: context.project.id,
    taskId: context.task.id,
    taskNumber: context.task.number,
    turnId: context.turn.id,
    turnSequence: context.turn.sequence,
  });
  assert.deepEqual(observed, ["turn.delivered", "build.dispatch.queued"]);

  complete(store, context.turn.id);
  assert.equal(store.listBuildDispatches().length, 1);
});

test("migration enables only an existing project whose repository matches OZDQP", () => {
  const config = createConfig();
  const legacy = new DatabaseSync(config.databasePath);
  legacy.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      guest_project_path TEXT NOT NULL,
      smb_path TEXT NOT NULL,
      unity_version TEXT,
      unity_skill_url TEXT,
      unity_health_url TEXT,
      unity_save_url TEXT,
      checkpoint_name TEXT NOT NULL DEFAULT 'PROJECT_READY',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const insert = legacy.prepare(`
    INSERT INTO projects (
      id, name, repo_url, default_branch, guest_project_path, smb_path,
      checkpoint_name, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, 'main', 'D:\\project', '\\\\host\\project',
      'PROJECT_READY', 1, '2026-07-27T00:00:00.000Z',
      '2026-07-27T00:00:00.000Z')
  `);
  insert.run("project-match", "ozdqp", REPOSITORY_URL);
  insert.run("project-other", "other", "https://example.invalid/other.git");
  legacy.close();

  const store = new Store(config);
  try {
    assert.equal(store.getProject("project-match").autoBuildEnabled, true);
    assert.equal(store.getProject("project-match").buildProjectKey, "ozdqp");
    assert.equal(store.getProject("project-other").autoBuildEnabled, false);
    assert.equal(store.getProject("project-other").buildProjectKey, null);
  } finally {
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  }
});

test("outbox insertion failure rolls back the successful turn and delivered event", (t) => {
  const config = createConfig();
  const store = new Store(config);
  t.after(() => {
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  });
  const { context } = seedTurn(store);
  store.db.exec(`
    CREATE TRIGGER reject_build_dispatch
    BEFORE INSERT ON build_dispatches
    BEGIN
      SELECT RAISE(ABORT, 'simulated outbox failure');
    END;
  `);

  assert.throws(
    () => complete(store, context.turn.id),
    /simulated outbox failure/u,
  );
  assert.equal(store.getTurn(context.turn.id).status, "preparing");
  assert.equal(store.getBuildDispatchForTurn(context.turn.id), null);
  assert.equal(
    store
      .listTaskEvents(context.task.id)
      .some((event) => event.type === "turn.delivered"),
    false,
  );
});

test("outbox is skipped unless every push proof and project gate is valid", async (t) => {
  const cases = [
    { name: "not pushed", proof: delivery({ pushed: false }) },
    { name: "not verified", proof: delivery({ verified: false }) },
    {
      name: "SHA mismatch",
      proof: delivery({ remoteSha: "f".repeat(40) }),
    },
    {
      name: "short SHA",
      proof: delivery({ commitSha: "abc123", remoteSha: "abc123" }),
    },
    { name: "project disabled", autoBuildEnabled: false },
    { name: "wrong project key", buildProjectKey: "other" },
    { name: "wrong repository", repoUrl: "https://example.invalid/other.git" },
    { name: "global switch disabled", globalEnabled: false },
  ];
  for (const current of cases) {
    await t.test(current.name, async () => {
      const config = createConfig({
        ozdqpBuildEnabled: current.globalEnabled ?? true,
      });
      const store = new Store(config);
      try {
        const { context } = seedTurn(store, current);
        complete(store, context.turn.id, current.proof || delivery());
        assert.equal(store.getTurn(context.turn.id).status, "success");
        assert.equal(store.getBuildDispatchForTurn(context.turn.id), null);
      } finally {
        await new Promise((resolve) => setImmediate(resolve));
        store.close();
        fs.rmSync(config.dataDirectory, { recursive: true, force: true });
      }
    });
  }
});

test("dispatcher retries 5xx, accepts the job, and leaves the Relay turn successful", async (t) => {
  const config = createConfig();
  const store = new Store(config);
  const { context, worker } = seedTurn(store);
  complete(store, context.turn.id);
  store.releaseWorkerAfterSuccess(worker.id);
  let calls = 0;
  const client = new OzdqpBuildClient({
    endpoint: "http://packer.invalid/api/v1/builds",
    fetcher: async () => {
      calls += 1;
      if (calls === 1) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({ job: { jobId: "job-after-503" } }), {
        status: 202,
      });
    },
  });
  const dispatcher = new BuildDispatcher({
    store,
    client,
    pollIntervalMs: 2,
    retryScheduleMs: [1],
    random: () => 0.5,
  });
  t.after(async () => {
    dispatcher.stop();
    await dispatcher.waitForIdle();
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  });

  dispatcher.start();
  const accepted = await waitUntil(() => {
    const value = store.getBuildDispatchForTurn(context.turn.id);
    return value?.status === "accepted" ? value : null;
  }, "retrying dispatch to be accepted");
  assert.equal(calls, 2);
  assert.equal(accepted.attemptCount, 2);
  assert.equal(accepted.ozdqpJobId, "job-after-503");
  assert.equal(store.getTurn(context.turn.id).status, "success");
  assert.equal(store.getWorker(worker.id).status, "ready");
  assert.ok(
    store
      .listTaskEvents(context.task.id)
      .some((event) => event.type === "build.dispatch.retrying"),
  );
});

test("dispatcher records 4xx as permanent without retrying or exposing response text", async (t) => {
  const config = createConfig();
  const store = new Store(config);
  const { context } = seedTurn(store);
  complete(store, context.turn.id);
  let calls = 0;
  const dispatcher = new BuildDispatcher({
    store,
    client: new OzdqpBuildClient({
      endpoint: "http://packer.invalid/api/v1/builds",
      fetcher: async () => {
        calls += 1;
        return new Response('{"error":"do-not-persist-this"}', {
          status: 422,
        });
      },
    }),
    pollIntervalMs: 2,
    retryScheduleMs: [1],
  });
  t.after(async () => {
    dispatcher.stop();
    await dispatcher.waitForIdle();
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  });

  dispatcher.start();
  const failed = await waitUntil(() => {
    const value = store.getBuildDispatchForTurn(context.turn.id);
    return value?.status === "failed" ? value : null;
  }, "permanent dispatch failure");
  assert.equal(calls, 1);
  assert.equal(failed.attemptCount, 1);
  assert.equal(failed.lastHttpStatus, 422);
  assert.equal(failed.lastErrorCode, "OZDQP_HTTP_PERMANENT");
  assert.doesNotMatch(JSON.stringify(failed), /do-not-persist-this/u);
  assert.equal(store.getTurn(context.turn.id).status, "success");
});

test("restart recovers sending work and retries it with the same idempotency key", async (t) => {
  const config = createConfig();
  let store = new Store(config);
  const { context } = seedTurn(store);
  complete(store, context.turn.id);
  const firstClaim = store.claimNextBuildDispatch();
  assert.equal(firstClaim.status, "sending");
  assert.equal(firstClaim.attemptCount, 1);
  await new Promise((resolve) => setImmediate(resolve));
  store.close();

  store = new Store(config);
  const recovered = store.getBuildDispatch(firstClaim.id);
  assert.equal(recovered.status, "retrying");
  assert.equal(recovered.lastErrorCode, "RELAY_RESTARTED_DURING_DISPATCH");
  const keys = [];
  const dispatcher = new BuildDispatcher({
    store,
    client: {
      submit: async (dispatch) => {
        keys.push(dispatch.idempotencyKey);
        return { jobId: "job-after-restart", status: 200, deduplicated: true };
      },
    },
    pollIntervalMs: 2,
    retryScheduleMs: [1],
  });
  t.after(async () => {
    dispatcher.stop();
    await dispatcher.waitForIdle();
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  });
  dispatcher.start();
  const accepted = await waitUntil(() => {
    const value = store.getBuildDispatch(firstClaim.id);
    return value?.status === "accepted" ? value : null;
  }, "recovered dispatch");
  assert.equal(accepted.attemptCount, 2);
  assert.deepEqual(keys, [firstClaim.idempotencyKey]);
});

test("timeout after server acceptance retries idempotently and creates one Packer job", async (t) => {
  const requests = [];
  const jobs = new Map();
  let createdJobs = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const key = request.headers["idempotency-key"];
      requests.push({
        key,
        body: Buffer.concat(chunks).toString("utf8"),
        apiKey: request.headers["x-ozdqp-api-key"],
      });
      if (!jobs.has(key)) {
        createdJobs += 1;
        jobs.set(key, `job-${createdJobs}`);
      }
      const payload = JSON.stringify({
        job: { jobId: jobs.get(key) },
        deduplicated: requests.length > 1,
      });
      const send = () => {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(requests.length === 1 ? 202 : 200, {
          "Content-Type": "application/json",
        });
        response.end(payload);
      };
      if (requests.length === 1) setTimeout(send, 80);
      else send();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );

  const config = createConfig();
  const store = new Store(config);
  const { context } = seedTurn(store);
  complete(store, context.turn.id);
  const endpoint = `http://127.0.0.1:${server.address().port}/api/v1/builds`;
  const dispatcher = new BuildDispatcher({
    store,
    client: new OzdqpBuildClient({
      endpoint,
      apiKey: "private-test-token",
      timeoutMs: 20,
    }),
    pollIntervalMs: 2,
    retryScheduleMs: [1],
    random: () => 0.5,
  });
  t.after(async () => {
    dispatcher.stop();
    await dispatcher.waitForIdle();
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  });

  dispatcher.start();
  const accepted = await waitUntil(() => {
    const value = store.getBuildDispatchForTurn(context.turn.id);
    return value?.status === "accepted" ? value : null;
  }, "idempotent timeout retry");
  assert.equal(requests.length, 2);
  assert.equal(createdJobs, 1);
  assert.equal(requests[0].key, requests[1].key);
  assert.equal(requests[0].body, requests[1].body);
  assert.ok(
    requests.every((request) => request.apiKey === "private-test-token"),
  );
  assert.equal(accepted.ozdqpJobId, "job-1");
  const persistedAudit = JSON.stringify({
    dispatches: store.listBuildDispatches(),
    events: store.listTaskEvents(context.task.id),
  });
  assert.doesNotMatch(persistedAudit, /private-test-token/u);
});

test("multiple successful turns on one task are claimed in turn order", async () => {
  const config = createConfig();
  const store = new Store(config);
  try {
    const { context, task, worker } = seedTurn(store);
    const followUp = store.appendTurn(task.id, {
      message: "Follow up before the first delivery completes",
    });
    complete(store, context.turn.id);
    assert.equal(store.getTask(task.id).status, "queued");
    store.releaseWorkerAfterSuccess(worker.id);
    const second = store.claimNextTurn();
    assert.equal(second.turn.id, followUp.id);
    complete(store, second.turn.id, {
      ...delivery(),
      commitSha: "f".repeat(40),
      remoteSha: "f".repeat(40),
    });

    const firstDispatch = store.claimNextBuildDispatch();
    assert.equal(firstDispatch.turnId, context.turn.id);
    store.acceptBuildDispatch(firstDispatch.id, {
      jobId: "job-first",
      status: 202,
    });
    const secondDispatch = store.claimNextBuildDispatch();
    assert.equal(secondDispatch.turnId, followUp.id);
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    store.close();
    fs.rmSync(config.dataDirectory, { recursive: true, force: true });
  }
});
