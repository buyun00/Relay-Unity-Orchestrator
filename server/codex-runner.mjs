import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCodexSandboxHelperDirectory } from "./codex-session.mjs";
import { runProcess } from "./process.mjs";
import { parseJson, resolveWorkerTemplate } from "./util.mjs";

const schemaPath = fileURLToPath(
  new URL("./codex-output.schema.json", import.meta.url),
);
const dialogStateScript = fileURLToPath(
  new URL("../scripts/hyperv/Get-UnityDialogGuardState.ps1", import.meta.url),
);
const dialogActionScript = fileURLToPath(
  new URL(
    "../scripts/hyperv/Invoke-UnityDialogGuardAction.ps1",
    import.meta.url,
  ),
);

function eventThreadId(event) {
  if (event?.type !== "thread.started") return null;
  return event.thread_id || event.threadId || event.thread?.id || null;
}

function attachmentPrompt(attachment) {
  const extension = path.extname(attachment.filename || "").toLowerCase();
  const isText =
    attachment.contentType?.startsWith("text/") ||
    [".txt", ".log", ".md", ".json", ".xml", ".yaml", ".yml"].includes(
      extension,
    );
  if (!isText) return `- ${attachment.filename}: ${attachment.path}`;
  try {
    const content = fs.readFileSync(attachment.path, "utf8");
    const limit = 200_000;
    const excerpt = content.slice(0, limit);
    const truncated = content.length > limit ? "\n[attachment truncated]" : "";
    return [
      `- ${attachment.filename} (${attachment.path})`,
      "<attachment>",
      excerpt,
      truncated,
      "</attachment>",
    ].join("\n");
  } catch (error) {
    return `- ${attachment.filename}: ${attachment.path} (could not inline: ${error.message})`;
  }
}

function buildPrompt(context) {
  const attachmentNote = context.attachments.length
    ? `\nAttachments supplied by the user for this turn:\n${context.attachments.map(attachmentPrompt).join("\n")}`
    : "";
  return [
    `You are executing turn ${context.turn.sequence} for persistent task #${context.task.number}: ${context.task.title}.`,
    `Work only on branch ${context.task.branchName}. The workspace is managed externally; do not switch branches or push.`,
    "Use the configured Unity Skill whenever the task requires inspecting or editing scenes, prefabs, or serialized Unity assets.",
    `If Unity or its Skill times out, inspect pending guest dialogs before treating the timeout as terminal. Read them with ${dialogStateScript} using VMName ${context.worker.vmName} and CredentialPath ${context.worker.credentialPath}.`,
    `For an unknown dialog, reason from its title, text, screenshot, and enumerated buttons, then use ${dialogActionScript} only with the exact dialogId/buttonId returned by the state interface. Never authorize a high-risk action without explicit user authority.`,
    "Complete the requested change, validate proportionally, and return the required structured result.",
    "",
    context.turn.userMessage,
    attachmentNote,
  ].join("\n");
}

export class CodexRunner {
  constructor(
    config,
    {
      processRunner = runProcess,
      runtimeDirectoryResolver = findCodexSandboxHelperDirectory,
    } = {},
  ) {
    this.config = config;
    this.processRunner = processRunner;
    this.runtimeDirectoryResolver = runtimeDirectoryResolver;
  }

  runtimeDirectory() {
    if (!/^codex(?:\.exe)?$/iu.test(this.config.codexCommand || "")) {
      return null;
    }
    return this.runtimeDirectoryResolver?.() || null;
  }

  command(runtimeDirectory = this.runtimeDirectory()) {
    const runtimeCommand = runtimeDirectory
      ? path.join(runtimeDirectory, "codex.exe")
      : null;
    return runtimeCommand && fs.existsSync(runtimeCommand)
      ? runtimeCommand
      : this.config.codexCommand;
  }

  environment(runtimeDirectory = this.runtimeDirectory()) {
    const environment = {};
    if (this.config.codexHome) environment.CODEX_HOME = this.config.codexHome;
    if (runtimeDirectory) {
      const inheritedPath = process.env.PATH || "";
      const existing = inheritedPath
        .split(path.delimiter)
        .some(
          (entry) =>
            path.resolve(entry).toLowerCase() ===
            path.resolve(runtimeDirectory).toLowerCase(),
        );
      environment.PATH = existing
        ? inheritedPath
        : [runtimeDirectory, inheritedPath]
            .filter(Boolean)
            .join(path.delimiter);
    }
    return Object.keys(environment).length ? environment : undefined;
  }

  async inspect() {
    const runtimeDirectory = this.runtimeDirectory();
    const command = this.command(runtimeDirectory);
    const status = {
      command,
      home: this.config.codexHome,
      available: false,
      authenticated: false,
      version: null,
      loginStatus: null,
      error: null,
    };
    try {
      const version = await this.processRunner(command, ["--version"], {
        env: this.environment(runtimeDirectory),
        timeoutMs: 15_000,
      });
      status.available = true;
      status.version = (version.stdout || version.stderr).trim() || null;
      const login = await this.processRunner(command, ["login", "status"], {
        env: this.environment(runtimeDirectory),
        timeoutMs: 15_000,
        acceptExitCodes: [0, 1],
      });
      status.authenticated = login.exitCode === 0;
      status.loginStatus = (login.stdout || login.stderr).trim() || null;
    } catch (error) {
      status.error = error.message;
    }
    return status;
  }

  async run(context, { signal, onEvent }) {
    const workspace = context.worker.sharePath || context.project.smbPath;
    if (!workspace) {
      throw Object.assign(
        new Error("Worker SMB workspace path is not configured"),
        { code: "SMB_PATH_MISSING" },
      );
    }
    const turnLogDirectory = path.join(
      this.config.logDirectory,
      context.task.id,
    );
    fs.mkdirSync(turnLogDirectory, { recursive: true });
    const jsonlPath = path.join(
      turnLogDirectory,
      `${context.turn.sequence}-${context.turn.id}.jsonl`,
    );
    const finalPath = path.join(
      turnLogDirectory,
      `${context.turn.sequence}-${context.turn.id}.final.json`,
    );
    const logStream = fs.createWriteStream(jsonlPath, {
      flags: "a",
      encoding: "utf8",
    });
    let threadId = context.task.codexThreadId || null;
    let lineBuffer = "";
    const codexModel = context.task.codexModel || this.config.codexModel;
    const codexReasoningEffort =
      context.task.codexReasoningEffort || this.config.codexReasoningEffort;
    const codexFastMode =
      context.task.codexFastMode ?? this.config.codexServiceTier === "fast";

    const args = [
      "-C",
      workspace,
      "--model",
      codexModel,
      "-c",
      `model_reasoning_effort=${JSON.stringify(codexReasoningEffort)}`,
      "-c",
      `service_tier=${JSON.stringify(codexFastMode ? "fast" : "default")}`,
      "-c",
      `features.fast_mode=${codexFastMode}`,
    ];
    const unitySkillUrl = resolveWorkerTemplate(
      context.project.unitySkillUrl,
      context.worker,
    );
    if (unitySkillUrl) {
      args.push(
        "-c",
        `mcp_servers.unity.url=${JSON.stringify(unitySkillUrl)}`,
        "-c",
        "mcp_servers.unity.required=true",
      );
    }
    args.push(
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "never",
      "exec",
    );
    if (threadId) args.push("resume");
    args.push(
      "--json",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      finalPath,
    );
    const prompt = buildPrompt(context);
    for (const attachment of context.attachments) {
      if (attachment.contentType?.startsWith("image/"))
        args.push("--image", attachment.path);
    }
    // `--image` accepts one or more paths, so terminate option parsing before
    // appending the positional session id and prompt.
    args.push("--");
    if (threadId) args.push(threadId, "-");
    else args.push("-");

    const consumeLines = (text) => {
      logStream.write(text);
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || "";
      for (const line of lines) {
        const event = parseJson(line, null);
        if (!event) continue;
        threadId ||= eventThreadId(event);
        onEvent?.(event);
      }
    };

    try {
      const runtimeDirectory = this.runtimeDirectory();
      await this.processRunner(this.command(runtimeDirectory), args, {
        cwd: workspace,
        env: this.environment(runtimeDirectory),
        input: prompt,
        signal,
        timeoutMs: this.config.codexTimeoutMs,
        onStdout: consumeLines,
        onStderr: (text) =>
          onEvent?.({ type: "codex.stderr", message: text.trim() }),
      });
      if (lineBuffer.trim()) {
        const event = parseJson(lineBuffer, null);
        if (event) {
          threadId ||= eventThreadId(event);
          onEvent?.(event);
        }
      }
    } finally {
      await new Promise((resolve) => logStream.end(resolve));
    }

    if (!threadId) {
      throw Object.assign(
        new Error(
          "Codex did not emit thread.started; persistent session cannot be guaranteed",
        ),
        {
          code: "CODEX_THREAD_ID_MISSING",
        },
      );
    }
    const rawFinal = fs.existsSync(finalPath)
      ? fs.readFileSync(finalPath, "utf8").trim()
      : "";
    const final = parseJson(rawFinal, {
      status: "completed",
      summary:
        rawFinal || "Codex completed without a structured final message.",
      changedFiles: [],
      validation: [],
      risks: ["Structured output was unavailable."],
      question: null,
    });
    return { threadId, final, jsonlPath, finalPath };
  }
}
