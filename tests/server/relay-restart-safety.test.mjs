import assert from "node:assert/strict";
import test from "node:test";
import { acquireRelayIdleWindow } from "../../server/relay-restart-safety.mjs";

function harness({
  activeTurns = 0,
  paused = false,
  raced = 0,
  ok = true,
} = {}) {
  const calls = [];
  return {
    calls,
    probe: async () => ({ ok, body: { scheduler: { activeTurns, paused } } }),
    setPaused: async (value) => {
      calls.push(value);
      return { scheduler: { activeTurns: raced, paused: value } };
    },
  };
}

test("busy business work is never paused or restarted for deployment", async () => {
  const h = harness({ activeTurns: 3 });
  await assert.rejects(acquireRelayIdleWindow(h), { code: "RELAY_BUSY" });
  assert.deepEqual(h.calls, []);
});

test("idle restart acquires an atomic pause and releases it on failure", async () => {
  const h = harness();
  const release = await acquireRelayIdleWindow(h);
  assert.deepEqual(h.calls, [true]);
  await release();
  await release();
  assert.deepEqual(h.calls, [true, false]);
});

test("a dispatch racing the idle check aborts restart and restores dispatch", async () => {
  const h = harness({ raced: 1 });
  await assert.rejects(acquireRelayIdleWindow(h), { code: "RELAY_BUSY" });
  assert.deepEqual(h.calls, [true, false]);
});

test("successful restart does not resume over the new runtime preflight", async () => {
  const h = harness();
  const release = await acquireRelayIdleWindow(h);
  await release({ restarted: true });
  assert.deepEqual(h.calls, [true]);
});

test("an operator pause is not cleared by a failed restart attempt", async () => {
  const h = harness({ paused: true });
  const release = await acquireRelayIdleWindow(h);
  await release();
  assert.deepEqual(h.calls, []);
});

test("unavailable backend can still be recovered without scheduler calls", async () => {
  const h = harness({ ok: false });
  h.allowUnavailable = true;
  const release = await acquireRelayIdleWindow(h);
  await release({ restarted: true });
  assert.deepEqual(h.calls, []);
});

test("a single health timeout cannot authorize killing unknown business work", async () => {
  const h = harness({ ok: false });
  await assert.rejects(acquireRelayIdleWindow(h), {
    code: "RELAY_STATE_UNAVAILABLE",
  });
  assert.deepEqual(h.calls, []);
});

test("healthy service with unknown active count is not killed", async () => {
  const h = harness();
  h.probe = async () => ({ ok: true, body: {} });
  await assert.rejects(acquireRelayIdleWindow(h), {
    code: "RELAY_STATE_UNKNOWN",
  });
  assert.deepEqual(h.calls, []);
});
