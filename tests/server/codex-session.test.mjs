import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexSessionRunner } from "../../server/codex-session.mjs";

test("persistent Ops prompts use stdin and resume without Windows command-line overflow", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-session-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const runner = new CodexSessionRunner(
    {
      codexCommand: "codex",
      codexTimeoutMs: 10_000,
      opsCodexModel: "test-model",
      opsCodexReasoningEffort: "high",
      opsCodexFastMode: false,
      codexHome: null,
    },
    {
      processRunner: async (command, args, options) => {
        calls.push({ command, args, options });
        const finalPath = args[args.indexOf("--output-last-message") + 1];
        fs.writeFileSync(
          finalPath,
          JSON.stringify({
            status: "resolved",
            summary: "healthy",
            diagnosis: "none",
            confidence: 1,
            actions: [],
            verification: "complete",
          }),
          "utf8",
        );
        options.onStdout?.(
          `${JSON.stringify({
            type: "thread.started",
            thread_id: "ops-thread-from-stdin",
          })}\n`,
        );
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  const longPrompt = `inspect\n${"context ".repeat(20_000)}`;

  const first = await runner.run({
    cwd: root,
    prompt: longPrompt,
    schemaPath: path.resolve("server/ops-output.schema.json"),
    logDirectory: root,
    logName: "first",
  });
  const resumed = await runner.run({
    cwd: root,
    threadId: first.threadId,
    prompt: "follow-up",
    schemaPath: path.resolve("server/ops-output.schema.json"),
    logDirectory: root,
    logName: "second",
  });

  assert.equal(resumed.threadId, "ops-thread-from-stdin");
  assert.equal(calls[0].args.at(-1), "-");
  assert.equal(calls[0].options.input, longPrompt);
  assert.equal(calls[0].args.includes(longPrompt), false);
  assert.ok(calls[1].args.includes("resume"));
  assert.deepEqual(calls[1].args.slice(-2), ["ops-thread-from-stdin", "-"]);
  assert.equal(calls[1].options.input, "follow-up");
});
