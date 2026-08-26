import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Store } from "../../server/db.mjs";
import {
  QaHubM2mService,
  canonicalPayloadHash,
} from "../../server/qa-hub-m2m.mjs";
import { QaHubM2mSqliteStore } from "../../server/qa-hub-m2m-store.mjs";
import { normalizeQaHubWebhookEvent } from "../../server/qa-hub-webhook-outbox.mjs";

const TOKEN = "qa-hub-test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

function attachment(bytes = Buffer.from("qa evidence\n")) {
  return {
    attachmentId: "attachment-1",
    filename: "evidence.txt",
    mediaType: "text/plain",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64"),
  };
}

function handoffBody(overrides = {}) {
  return {
    qaInstanceId: "qa-local",
    handoffId: "handoff-1",
    attemptId: "attempt-1",
    defect: {
      id: "defect-1",
      key: "BUG-1",
      revision: 1,
      projectKey: "OZDQP",
      title: "Canary defect",
      description: "The canary should be repaired.",
      severity: "S2",
      verificationCriteria: "The canary evidence is visible.",
    },
    selectedAttachments: [attachment()],
    ...overrides,
  };
}

function service(overrides = {}) {
  const created = [];
  const appended = [];
  const instance = new QaHubM2mService({
    token: TOKEN,
    scopes: [
      "qa:handoff:create",
      "qa:handoff:continue",
      "qa:handoff:read",
    ],
    projectMap: new Map([["OZDQP", "project-ozdqp"]]),
    create: async (input) => {
      created.push(input);
      return {
        task: { id: "task-qa-1", status: "queued" },
        turn: { id: "turn-qa-1", status: "queued" },
      };
    },
    append: async (taskId, input) => {
      appended.push({ taskId, input });
      return { id: "turn-qa-2", status: "queued" };
    },
    queryAdapter: async () => ({
      status: "queued",
      task: { id: "task-qa-1", status: "queued", path: "D:\\secret\\must-not-leak" },
      turns: [{ id: "turn-qa-1", status: "queued" }],
      latestDeliveryEvidence: null,
    }),
    ...overrides,
  });
  return { instance, created, appended };
}

function request(body, idempotencyKey) {
  return {
    headers: { ...AUTH, "idempotency-key": idempotencyKey },
    remoteAddress: "127.0.0.1",
    body,
  };
}

test("M2M create uses server project mapping, inline attachment bytes, and stable replay", async () => {
  const { instance, created } = service();
  const body = handoffBody();
  const key = "qa:qa-local:handoff:handoff-1";
  const first = await instance.handleCreate(request(body, key));
  assert.equal(first.statusCode, 202);
  assert.deepEqual(
    { taskId: first.body.taskId, initialTurnId: first.body.initialTurnId },
    { taskId: "task-qa-1", initialTurnId: "turn-qa-1" },
  );
  assert.equal(created.length, 1);
  assert.equal(created[0].projectId, "project-ozdqp");
  assert.equal(created[0].preparedAttachments[0].bytes.toString("utf8"), "qa evidence\n");
  for (const forbidden of ["repoUrl", "path", "workerId", "branchName", "baseBranch"]) {
    assert.equal(Object.hasOwn(created[0], forbidden), false, forbidden);
  }

  const replay = await instance.handleCreate(request(body, key));
  assert.equal(replay.statusCode, 202);
  assert.equal(replay.body.replayed, true);
  assert.equal(created.length, 1);
  assert.equal(canonicalPayloadHash(body), canonicalPayloadHash({ ...body, selectedAttachments: [{ ...body.selectedAttachments[0], downloadUrl: "https://rotated.invalid/a" }] }));
});

test("M2M rejects idempotency conflicts, non-loopback callers, scopes, and client-controlled paths", async () => {
  const { instance, created } = service();
  const body = handoffBody();
  const key = "qa:qa-local:handoff:handoff-1";
  await instance.handleCreate(request(body, key));
  const conflict = await instance.handleCreate(
    request({ ...body, defect: { ...body.defect, title: "changed" } }, key),
  );
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");

  const nonLoopback = await instance.handleCreate({
    ...request(body, "qa:qa-local:handoff:other"),
    remoteAddress: "10.0.0.5",
  });
  assert.equal(nonLoopback.statusCode, 403);

  const forbiddenField = await instance.handleCreate(
    request({ ...body, branchName: "client-controlled" }, "qa:qa-local:handoff:other"),
  );
  assert.equal(forbiddenField.statusCode, 400);
  assert.equal(created.length, 1);
});

test("attachment hash failure happens before create and continue is action-idempotent", async () => {
  const { instance, created, appended } = service();
  const body = handoffBody({
    selectedAttachments: [{ ...attachment(), sha256: "0".repeat(64) }],
  });
  const failed = await instance.handleCreate(
    request(body, "qa:qa-local:handoff:handoff-1"),
  );
  assert.equal(failed.statusCode, 422);
  assert.equal(failed.body.code, "ATTACHMENT_HASH_MISMATCH");
  assert.equal(created.length, 0);

  const createdOk = await instance.handleCreate(
    request(handoffBody(), "qa:qa-local:handoff:handoff-1"),
  );
  assert.equal(createdOk.statusCode, 202);
  const continueBody = {
    qaInstanceId: "qa-local",
    actionId: "action-1",
    attemptId: "attempt-1",
    prompt: "Please recheck the evidence.",
  };
  const key = "qa:qa-local:action:action-1";
  const first = await instance.handleContinue("handoff-1", request(continueBody, key));
  const replay = await instance.handleContinue("handoff-1", request(continueBody, key));
  assert.equal(first.statusCode, 202);
  assert.equal(first.body.turnId, "turn-qa-2");
  assert.equal(replay.body.replayed, true);
  assert.equal(appended.length, 1);
});

test("real Store keeps receipt, binding, attachment, outbox, and same-task continue across restart", async (t) => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-qa-m2m-store-"),
  );
  const config = {
    version: "qa-m2m-store-test",
    dataDirectory,
    databasePath: path.join(dataDirectory, "pipeline.sqlite"),
    uploadDirectory: path.join(dataDirectory, "uploads"),
    logDirectory: path.join(dataDirectory, "logs"),
    uploadLimitBytes: 25 * 1024 * 1024,
    ozdqpBuildEnabled: false,
  };
  let store = new Store(config);
  t.after(() => {
    try {
      store.close();
    } catch {
      // The test closes and reopens the Store once.
    }
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });
  const project = store.createProject({
    id: "project-qa-real",
    name: "QA real Store project",
    repoUrl: "https://example.invalid/qa-real.git",
    defaultBranch: "main",
    guestProjectPath: "D:\\Work\\qa-real",
    smbPath: "\\\\127.0.0.1\\qa-real",
    checkpointName: "PROJECT_READY",
  });
  const projectMap = new Map([["OZDQP", project.id]]);
  let persistence = new QaHubM2mSqliteStore({ store });
  const m2m = persistence.m2mAdapter();
  const persistEvent = (event) => {
    const binding = persistence.getHandoffByTaskId(event.taskId);
    if (!binding) return;
    const record = normalizeQaHubWebhookEvent(
      {
        ...event,
        data: {
          ...(event.data || {}),
          ...(event.type === "turn.delivered"
            ? {
                buildRequirement: {
                  required: false,
                  projectKey: null,
                },
              }
            : {}),
        },
        handoffId: binding.handoffId,
        attemptId: binding.attemptId,
        externalRevision: event.id,
      },
      "relay-test",
    );
    if (record) persistence.enqueue(record);
  };
  const stopSink = store.onDurableEvent(persistEvent);
  let instance = new QaHubM2mService({
    store,
    token: TOKEN,
    scopes: [
      "qa:handoff:create",
      "qa:handoff:continue",
      "qa:handoff:read",
    ],
    projectMap,
    idempotency: m2m,
    bindings: m2m,
    atomicPersistence: persistence.atomicPersistence(),
    uploadDirectory: config.uploadDirectory,
  });
  const body = handoffBody();
  const createKey = "qa:qa-local:handoff:handoff-1";
  const created = await instance.handleCreate(request(body, createKey));
  assert.equal(created.statusCode, 202);
  await new Promise((resolve) => setImmediate(resolve));
  const firstTask = store.getTask(created.body.taskId);
  store.setTaskThread(firstTask.id, "thread-qa-real");
  assert.equal(store.listTurnAttachments(created.body.initialTurnId).length, 1);
  assert.equal(persistence.getHandoffByTaskId(firstTask.id).handoffId, "handoff-1");
  assert.equal(persistence.list()[0].eventType, "submitted");

  stopSink();
  store.close();
  store = new Store(config);
  persistence = new QaHubM2mSqliteStore({ store });
  const reopenedAdapter = persistence.m2mAdapter();
  instance = new QaHubM2mService({
    store,
    token: TOKEN,
    scopes: [
      "qa:handoff:create",
      "qa:handoff:continue",
      "qa:handoff:read",
    ],
    projectMap,
    idempotency: reopenedAdapter,
    bindings: reopenedAdapter,
    atomicPersistence: persistence.atomicPersistence(),
    uploadDirectory: config.uploadDirectory,
  });
  const replay = await instance.handleCreate(request(body, createKey));
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.taskId, firstTask.id);
  const continued = await instance.handleContinue(
    "handoff-1",
    request(
      {
        qaInstanceId: "qa-local",
        actionId: "action-real-1",
        attemptId: "attempt-1",
        prompt: "Continue the same Relay task without changing its workspace identity.",
      },
      "qa:qa-local:action:action-real-1",
    ),
  );
  assert.equal(continued.statusCode, 202);
  assert.equal(continued.body.taskId, firstTask.id);
  assert.equal(store.listTaskTurns(firstTask.id).length, 2);
  const after = store.getTask(firstTask.id);
  assert.equal(after.branchName, firstTask.branchName);
  assert.equal(after.codexThreadId, "thread-qa-real");
});
