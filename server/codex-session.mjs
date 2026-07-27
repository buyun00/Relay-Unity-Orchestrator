import fs from "node:fs";
import path from "node:path";
import { runProcess } from "./process.mjs";
import { parseJson } from "./util.mjs";

function eventThreadId(event) {
  if (event?.type !== "thread.started") return null;
  return event.thread_id || event.threadId || event.thread?.id || null;
}

export class CodexSessionRunner {
  constructor(config, { processRunner = runProcess } = {}) {
    this.config = config;
    this.processRunner = processRunner;
  }

  environment() {
    return this.config.codexHome
      ? { CODEX_HOME: this.config.codexHome }
      : undefined;
  }

  async run({
    cwd,
    threadId = null,
    prompt,
    schemaPath,
    logDirectory,
    logName,
    sandbox = "read-only",
    model = this.config.opsCodexModel || this.config.codexModel,
    reasoningEffort = this.config.opsCodexReasoningEffort ||
      this.config.codexReasoningEffort,
    fastMode = this.config.opsCodexFastMode ??
      this.config.codexServiceTier === "fast",
    signal,
    onEvent,
  }) {
    fs.mkdirSync(logDirectory, { recursive: true });
    const jsonlPath = path.join(logDirectory, `${logName}.jsonl`);
    const finalPath = path.join(logDirectory, `${logName}.final.json`);
    const stream = fs.createWriteStream(jsonlPath, {
      flags: "a",
      encoding: "utf8",
    });
    const args = [
      "-C",
      cwd,
      "--model",
      model,
      "-c",
      `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
      "-c",
      `service_tier=${JSON.stringify(fastMode ? "fast" : "default")}`,
      "-c",
      `features.fast_mode=${Boolean(fastMode)}`,
      "--sandbox",
      sandbox,
      "--ask-for-approval",
      "never",
      "exec",
    ];
    if (threadId) args.push("resume");
    args.push(
      "--json",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      finalPath,
      "--",
    );
    if (threadId) args.push(threadId, "-");
    else args.push("-");

    let currentThreadId = threadId;
    let lineBuffer = "";
    const consume = (text) => {
      stream.write(text);
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/u);
      lineBuffer = lines.pop() || "";
      for (const line of lines) {
        const event = parseJson(line, null);
        if (!event) continue;
        currentThreadId ||= eventThreadId(event);
        onEvent?.(event);
      }
    };

    try {
      await this.processRunner(this.config.codexCommand, args, {
        cwd,
        env: this.environment(),
        input: prompt,
        signal,
        timeoutMs: this.config.codexTimeoutMs,
        onStdout: consume,
        onStderr: (text) =>
          onEvent?.({ type: "codex.stderr", message: text.trim() }),
      });
      if (lineBuffer.trim()) {
        const event = parseJson(lineBuffer, null);
        if (event) {
          currentThreadId ||= eventThreadId(event);
          onEvent?.(event);
        }
      }
    } finally {
      await new Promise((resolve) => stream.end(resolve));
    }

    if (!currentThreadId) {
      throw Object.assign(
        new Error(
          "Codex did not emit thread.started; the Ops conversation cannot be resumed",
        ),
        { code: "CODEX_THREAD_ID_MISSING" },
      );
    }
    const rawFinal = fs.existsSync(finalPath)
      ? fs.readFileSync(finalPath, "utf8").trim()
      : "";
    const final = parseJson(rawFinal, null);
    if (!final) {
      throw Object.assign(
        new Error("Codex did not return valid structured output"),
        { code: "CODEX_STRUCTURED_OUTPUT_MISSING" },
      );
    }
    return {
      threadId: currentThreadId,
      final,
      jsonlPath,
      finalPath,
    };
  }
}
