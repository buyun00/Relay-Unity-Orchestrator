import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("a valid completion artifact ends a child that does not close its pipes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-process-final-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const finalPath = path.join(root, "final.json");
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({status:'completed'})); setInterval(() => {}, 1000);",
      finalPath,
    ],
    {
      timeoutMs: 5_000,
      completionCheck: () => {
        if (!fs.existsSync(finalPath)) return false;
        return (
          JSON.parse(fs.readFileSync(finalPath, "utf8")).status === "completed"
        );
      },
      completionGraceMs: 50,
    },
  );

  assert.equal(result.completedBySentinel, true);
  assert.ok(fs.existsSync(finalPath));
});
