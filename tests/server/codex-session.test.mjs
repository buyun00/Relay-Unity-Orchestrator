import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CodexSessionRunner,
  findCodexSandboxHelperDirectory,
} from "../../server/codex-session.mjs";

test("Windows Codex sandbox helpers are discovered from the desktop runtime", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific sandbox helper discovery");
    return;
  }
  const localAppData = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-codex-runtime-"),
  );
  t.after(() => fs.rmSync(localAppData, { recursive: true, force: true }));
  const runtimeRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  const older = path.join(runtimeRoot, "older");
  const current = path.join(runtimeRoot, "current");
  for (const directory of [older, current]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "codex.exe"), "");
    fs.writeFileSync(
      path.join(directory, "codex-windows-sandbox-setup.exe"),
      "",
    );
    fs.writeFileSync(path.join(directory, "codex-command-runner.exe"), "");
  }
  const olderTime = new Date("2026-01-01T00:00:00Z");
  const currentTime = new Date("2026-07-27T00:00:00Z");
  for (const name of [
    "codex-windows-sandbox-setup.exe",
    "codex-command-runner.exe",
  ]) {
    fs.utimesSync(path.join(older, name), olderTime, olderTime);
    fs.utimesSync(path.join(current, name), currentTime, currentTime);
  }

  assert.equal(findCodexSandboxHelperDirectory(localAppData), current);
});

test("persistent Ops prompts use stdin and resume without Windows command-line overflow", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-session-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const helperDirectory = path.join(root, "codex-runtime-bin");
  fs.mkdirSync(helperDirectory);
  fs.writeFileSync(path.join(helperDirectory, "codex.exe"), "");
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
      sandboxHelperDirectoryResolver: () => helperDirectory,
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
        options.onStderr?.("non-fatal Codex diagnostic\n");
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
  assert.match(
    fs.readFileSync(first.stderrPath, "utf8"),
    /non-fatal Codex diagnostic/u,
  );
  assert.equal(calls[0].command, path.join(helperDirectory, "codex.exe"));
  assert.equal(calls[0].args.at(-1), "-");
  assert.equal(calls[0].options.input, longPrompt);
  assert.equal(calls[0].args.includes(longPrompt), false);
  assert.equal(
    calls[0].options.env.PATH.split(path.delimiter)[0],
    helperDirectory,
  );
  assert.ok(calls[1].args.includes("resume"));
  assert.deepEqual(calls[1].args.slice(-2), ["ops-thread-from-stdin", "-"]);
  assert.equal(calls[1].options.input, "follow-up");
});
