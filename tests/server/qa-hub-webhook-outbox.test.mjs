import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  MemoryWebhookOutboxAdapter,
  QaHubWebhookOutbox,
  verifyWebhookSignature,
} from "../../server/qa-hub-webhook-outbox.mjs";

const SECRET = "webhook-test-secret";

function event(overrides = {}) {
  return {
    id: "event-1",
    type: "turn.delivered",
    taskId: "task-qa-1",
    turnId: "turn-qa-1",
    handoffId: "handoff-1",
    attemptId: "attempt-1",
    externalRevision: 2,
    occurredAt: "2026-08-26T10:00:00.000Z",
    data: {
      pushed: true,
      verified: true,
      commitSha: "a".repeat(40),
      remoteSha: "a".repeat(40),
      branchName: "qa/relay-canary",
      buildRequirement: { required: true, projectKey: "OZDQP" },
    },
    ...overrides,
  };
}

test("outbox snapshots a bound event, enforces revision idempotency, and signs raw bytes", async () => {
  const adapter = new MemoryWebhookOutboxAdapter();
  const outbox = new QaHubWebhookOutbox({
    adapter,
    relayInstanceId: "relay-main",
    endpoint: "http://127.0.0.1:4320/api/v1/integrations/relay/webhooks",
    secret: SECRET,
    clock: () => Date.parse("2026-08-26T10:00:05.000Z"),
  });
  const first = await outbox.notify(event(), {
    handoffId: "handoff-1",
    attemptId: "attempt-1",
    qaInstanceId: "qa-local",
  });
  assert.equal(first.queued, true);
  assert.equal(first.record.deliveryId, "relay-main:event:event-1");
  assert.equal(first.record.eventType, "fix_delivered");
  assert.equal(JSON.parse(first.record.body).payload.deliveryEvidence.branch, "qa/relay-canary");
  const replay = await outbox.notify(event(), {
    handoffId: "handoff-1",
    attemptId: "attempt-1",
    qaInstanceId: "qa-local",
  });
  assert.equal(replay.replayed, true);
  const stale = await outbox.notify(
    event({ id: "event-old", externalRevision: 1 }),
    { handoffId: "handoff-1", attemptId: "attempt-1" },
  );
  assert.equal(stale.ignored, true);
  await assert.rejects(
    outbox.notify(
      event({
        externalRevision: 2,
        data: {
          pushed: true,
          verified: true,
          commitSha: "a".repeat(40),
          remoteSha: "a".repeat(40),
          branchName: "qa/relay-canary",
          buildRequirement: { required: true, projectKey: "OZDQP" },
          statusReason: "different",
        },
      }),
      { handoffId: "handoff-1", attemptId: "attempt-1" },
    ),
    { code: "INTEGRATION_EVENT_CONFLICT" },
  );

  const record = first.record;
  const timestamp = "1787738405";
  const headers = outbox.headersFor(record, timestamp);
  assert.equal(
    headers["X-Relay-Signature"],
    `sha256=${createHmac("sha256", SECRET).update(`${timestamp}.${record.body}`).digest("hex")}`,
  );
  assert.equal(
    verifyWebhookSignature({
      secret: SECRET,
      timestamp,
      rawBody: Buffer.from(record.body),
      signature: headers["X-Relay-Signature"],
      now: Number(timestamp) * 1_000,
    }),
    true,
  );
});

test("outbox retries transient responses, dead-letters permanent responses, and recovers sending", async () => {
  const adapter = new MemoryWebhookOutboxAdapter();
  let calls = 0;
  const outbox = new QaHubWebhookOutbox({
    adapter,
    endpoint: "http://127.0.0.1:4320/api/v1/integrations/relay/webhooks",
    secret: SECRET,
    retryScheduleMs: [0],
    maxAttempts: 3,
    fetcher: async () => {
      calls += 1;
      return new Response("ok", { status: calls === 1 ? 503 : 200 });
    },
  });
  await outbox.notify(event(), { handoffId: "handoff-1", attemptId: "attempt-1" });
  await outbox.pumpOnce();
  let records = await adapter.list();
  assert.equal(records[0].status, "retrying");
  await outbox.pumpOnce();
  records = await adapter.list();
  assert.equal(calls, 2);
  assert.equal(records[0].status, "sent");

  const deadAdapter = new MemoryWebhookOutboxAdapter();
  const dead = new QaHubWebhookOutbox({
    adapter: deadAdapter,
    endpoint: "http://127.0.0.1:4320/api/v1/integrations/relay/webhooks",
    secret: SECRET,
    fetcher: async () => new Response("bad", { status: 401 }),
  });
  await dead.notify(event({ id: "event-2" }), { handoffId: "handoff-2", attemptId: "attempt-2" });
  await dead.pumpOnce();
  records = await deadAdapter.list();
  assert.equal(records[0].status, "dead_letter");

  const recoveredAdapter = new MemoryWebhookOutboxAdapter();
  await recoveredAdapter.enqueue({
    ...event({ id: "event-3" }),
    deliveryId: "relay-main:event:event-3",
    status: "sending",
    nextAttemptAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const recovered = await recoveredAdapter.recoverSending(Date.now());
  assert.equal(recovered, 1);
  assert.equal((await recoveredAdapter.list())[0].status, "retrying");
});
