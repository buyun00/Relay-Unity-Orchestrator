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

function workerUnityEndpoints(context) {
  const resolvedSkillUrl = resolveWorkerTemplate(
    context.project.unitySkillUrl,
    context.worker,
  );
  const resolvedHealthUrl = resolveWorkerTemplate(
    context.project.unityHealthUrl,
    context.worker,
  );
  const candidate = resolvedSkillUrl || resolvedHealthUrl;
  if (!candidate) return { baseUrl: null, mcpUrl: null };
  try {
    const url = new URL(candidate);
    const baseUrl = url.origin;
    return { baseUrl, mcpUrl: `${baseUrl}/mcp` };
  } catch {
    return { baseUrl: null, mcpUrl: resolvedSkillUrl || null };
  }
}

function workerUnityMcpBridgeUrl(config, context) {
  if (!context.worker?.id) return workerUnityEndpoints(context).mcpUrl;
  const port = Number(config.port) || 4317;
  return `http://127.0.0.1:${port}/api/workers/${encodeURIComponent(context.worker.id)}/unity-mcp`;
}

function buildPrompt(context) {
  const profile = context.turn.executionProfile || "auto";
  const unityEndpoints = workerUnityEndpoints(context);
  const workerUnityRoute = unityEndpoints.baseUrl
    ? [
        `Relay's authoritative Unity endpoint for this assigned Worker ${context.worker.name} is ${unityEndpoints.baseUrl}.`,
        "If a local AGENTS override or prior thread mentions another Worker's Unity IP, ignore that stale endpoint for this turn. Never send Unity or UnitySkills requests to a different Worker.",
      ]
    : [];
  const attachmentNote = context.attachments.length
    ? `\nAttachments supplied by the user for this turn:\n${context.attachments.map(attachmentPrompt).join("\n")}`
    : "";
  const routeInstructions = {
    code_only: [
      "Relay executionProfile=code_only for this turn.",
      "Work strictly through code, text, Git evidence, and static checks. Do not probe, start, wait for, restart, or repair Unity, UnitySkills, or UnityDialogGuard. Do not treat missing Unity compilation or Console evidence as a blocker.",
    ],
    auto: [
      "Relay executionProfile=auto for this turn: begin on the code-only route.",
      "Unity, UI, layout, Panel, View, and Prefab keywords do not by themselves justify Unity automation. Escalate to UnitySkills only after code-level investigation identifies the exact serialized asset or Editor operation required and explains why code alone cannot complete the request. Do not repair Unity merely to obtain optional validation evidence.",
      "Explicitly requested Unity compilation, runtime interaction, object readback, or Game View evidence is required work, not optional validation. Those explicit requirements authorize escalation to the assigned Worker's UnitySkills REST endpoint even when the implementation is code-only; auto never waives them. Do not infer Unity is unavailable from the absence of an Editor on the Relay host. Preserve these requirements across automatic correction turns.",
      ...workerUnityRoute,
      `Only after that explicit escalation, if Unity or UnitySkills times out, inspect pending guest dialogs with ${dialogStateScript} using VMName ${context.worker.vmName} and CredentialPath ${context.worker.credentialPath}. For an unknown dialog, use ${dialogActionScript} only with the exact dialogId/buttonId returned by the state interface, and never authorize a high-risk action without explicit user authority.`,
    ],
    unity_asset: [
      "Relay executionProfile=unity_asset for this turn.",
      "Use the configured Unity Skill to inspect or edit the requested real scenes, prefabs, components, hierarchy, serialized bindings, or other Editor state.",
      "Unity MCP availability is not a task-startup prerequisite. If that transport cannot initialize, use the assigned Worker's UnitySkills REST interface; preserve all requested runtime and visual verification, and report any evidence that remains unavailable.",
      ...workerUnityRoute,
      `If Unity or its Skill times out, inspect pending guest dialogs before treating the timeout as terminal. Read them with ${dialogStateScript} using VMName ${context.worker.vmName} and CredentialPath ${context.worker.credentialPath}.`,
      `For an unknown dialog, reason from its title, text, screenshot, and enumerated buttons, then use ${dialogActionScript} only with the exact dialogId/buttonId returned by the state interface. Never authorize a high-risk action without explicit user authority.`,
    ],
  }[profile] || ["Relay executionProfile=auto for this turn."];
  return [
    `You are executing turn ${context.turn.sequence} for persistent task #${context.task.number}: ${context.task.title}.`,
    `Work only on branch ${context.task.branchName}. The workspace is managed externally; do not switch branches or push.`,
    ...routeInstructions,
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
    const unitySkillUrl = workerUnityMcpBridgeUrl(this.config, context);
    if (unitySkillUrl && context.turn.executionProfile === "unity_asset") {
      args.push(
        "-c",
        `mcp_servers.unity.url=${JSON.stringify(unitySkillUrl)}`,
        "-c",
        "mcp_servers.unity.required=false",
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
