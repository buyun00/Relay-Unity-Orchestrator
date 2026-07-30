import assert from "node:assert/strict";
import test from "node:test";

import { runProcess } from "../../server/process.mjs";

test("a permanently hung owned child is terminated with captured stage evidence", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    () =>
      runProcess(
        process.execPath,
        [
          "-e",
          "process.stdout.write('before-timeout'); process.stderr.write('stage-stderr'); setInterval(() => {}, 1000);",
        ],
        { timeoutMs: 150 },
      ),
    (error) => {
      assert.equal(error.code, "PROCESS_TIMEOUT");
      assert.equal(error.timedOut, true);
      assert.equal(error.timeoutMs, 150);
      assert.equal(error.stdout, "before-timeout");
      assert.equal(error.stderr, "stage-stderr");
      assert.ok(Number.isInteger(error.exitCode) || error.signal);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 5_000);
});
