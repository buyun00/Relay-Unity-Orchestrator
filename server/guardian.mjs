import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "./config.mjs";
import { codexTaskSettings } from "./codex-settings.mjs";
import { CodexSessionRunner } from "./codex-session.mjs";
import {
  actionPolicyPrompt,
  suppressUnauthorizedActions,
} from "./ops-policy.mjs";
import { RepairManager } from "./repair-manager.mjs";
import { runProcess } from "./process.mjs";
import { acquireRelayIdleWindow } from "./relay-restart-safety.mjs";
import { id, now, parseJson } from "./util.mjs";

const opsSchemaPath = fileURLToPath(
  new URL("./ops-output.schema.json", import.meta.url),
);
const startedAt = now();
const emergencyStatePath = path.join(config.dataDirectory, "guardian-ops.json");
const guardianRepairStatePath = path.join(
  config.dataDirectory,
  "guardian-repairs.json",
);
fs.mkdirSync(config.dataDirectory, { recursive: true });
fs.mkdirSync(config.logDirectory, { recursive: true });

function readJsonFile(filePath, fallback) {
  try {
    return parseJson(fs.readFileSync(filePath, "utf8"), fallback);
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readBody(request, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(
          chunks.length
            ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
            : {},
        );
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Pipeline-User",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  });
  response.end(body);
}

async function probe(url, timeoutMs = 2_500) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: response.ok,
      status: response.status,
      body: response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : null,
    };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}

function serviceLogHandles(name) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return {
    stdout: fs.openSync(
      path.join(config.logDirectory, `${name}-${stamp}.stdout.log`),
      "a",
    ),
    stderr: fs.openSync(
      path.join(config.logDirectory, `${name}-${stamp}.stderr.log`),
      "a",
    ),
  };
}

function spawnService(entry, name) {
  const handles = serviceLogHandles(name);
  const child = spawn(
    process.execPath,
    ["--env-file-if-exists=.env.local", entry],
    {
      cwd: config.projectRoot,
      env: process.env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", handles.stdout, handles.stderr],
    },
  );
  child.unref();
  fs.closeSync(handles.stdout);
  fs.closeSync(handles.stderr);
  return child.pid;
}

async function stopRecognizedPort(port, commandPattern) {
  const script = [
    "& { param([int]$targetPort,[string]$pattern)",
    "$listeners=@(Get-NetTCPConnection -LocalPort $targetPort -State Listen -ErrorAction SilentlyContinue)",
    "foreach($listener in $listeners){",
    "  $pidValue=[int]$listener.OwningProcess",
    '  $process=Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue',
    "  if($process -and $process.CommandLine -match $pattern){ Stop-Process -Id $pidValue -Force -ErrorAction Stop }",
    "}",
    "}",
  ].join("; ");
  await runProcess(
    config.powershellCommand,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
      String(port),
      commandPattern,
    ],
    { timeoutMs: 20_000 },
  );
}

async function waitForPortToClose(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe(`http://127.0.0.1:${port}/`, 500);
    if (!result.ok && result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Port ${port} did not close before restart`);
}

const guardianState = {
  relayFailures: 0,
  webFailures: 0,
  relayRestarts: 0,
  webRestarts: 0,
  lastRelayHealth: null,
  lastWebHealth: null,
  lastError: null,
  monitoring: false,
  activationRunning: false,
};
let relayRestarting = false;
let webRestarting = false;

async function relayIdleWindow({ allowUnavailable = false } = {}) {
  return acquireRelayIdleWindow({
    allowUnavailable,
    probe: () => probe(`http://127.0.0.1:${config.port}/api/health`),
    setPaused: async (paused) => {
      const response = await fetch(
        `http://127.0.0.1:${config.port}/api/scheduler/${paused ? "pause" : "resume"}`,
        { method: "POST", signal: AbortSignal.timeout(5_000) },
      );
      if (!response.ok)
        throw new Error(`Relay scheduler control failed: ${response.status}`);
      return response.json();
    },
  });
}

async function restartRelay(reason = "Guardian health recovery") {
  if (relayRestarting) return { accepted: true, alreadyRunning: true };
  relayRestarting = true;
  let release;
  let restarted = false;
  try {
    release = await relayIdleWindow({
      allowUnavailable:
        guardianState.relayFailures >= config.guardianFailureThreshold,
    });
    await stopRecognizedPort(config.port, "server[\\\\/]index\\.mjs");
    await waitForPortToClose(config.port);
    const pid = spawnService(config.relayEntry, "backend-guardian");
    restarted = true;
    guardianState.relayRestarts += 1;
    guardianState.lastError = null;
    return { accepted: true, pid, reason };
  } finally {
    relayRestarting = false;
    await release?.({ restarted });
  }
}

async function restartWeb(reason = "Guardian health recovery") {
  if (webRestarting) return { accepted: true, alreadyRunning: true };
  webRestarting = true;
  try {
    await stopRecognizedPort(config.internalWebPort, "vinext.+\\bstart\\b");
    await stopRecognizedPort(config.webPort, "server[\\\\/]web\\.mjs");
    await Promise.all([
      waitForPortToClose(config.internalWebPort),
      waitForPortToClose(config.webPort),
    ]);
    if (
      config.webEntry === "server/web.mjs" &&
      !fs.existsSync(path.join(config.projectRoot, "dist", "client"))
    ) {
      throw new Error("Relay production web build is missing");
    }
    const pid = spawnService(config.webEntry, "web-guardian");
    guardianState.webRestarts += 1;
    guardianState.lastError = null;
    return { accepted: true, pid, reason };
  } finally {
    webRestarting = false;
  }
}

function bundledGitPath() {
  if (config.gitCommand !== "git") return config.gitCommand;
  const candidate = process.env.USERPROFILE
    ? path.join(
        process.env.USERPROFILE,
        ".cache",
        "codex-runtimes",
        "codex-primary-runtime",
        "dependencies",
        "native",
        "git",
        "cmd",
        "git.exe",
      )
    : null;
  return candidate && fs.existsSync(candidate) ? candidate : config.gitCommand;
}

async function git(args) {
  return runProcess(bundledGitPath(), args, {
    cwd: config.projectRoot,
    timeoutMs: 10 * 60 * 1000,
  });
}

async function buildMain() {
  return runProcess(
    process.execPath,
    [
      path.join(config.projectRoot, "node_modules", "vinext", "dist", "cli.js"),
      "build",
    ],
    {
      cwd: config.projectRoot,
      env: {
        WRANGLER_LOG_PATH: path.join(
          config.projectRoot,
          ".wrangler",
          "wrangler.log",
        ),
      },
      timeoutMs: 20 * 60 * 1000,
    },
  );
}

async function waitForServices(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [relay, web] = await Promise.all([
      probe(`http://127.0.0.1:${config.port}/api/health`),
      probe(`http://127.0.0.1:${config.webPort}/`),
    ]);
    if (relay.ok && web.ok) return { relay, web };
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Relay and web did not become healthy after deployment");
}

async function activatePendingDeployment() {
  if (guardianState.activationRunning) return;
  const deployment = readJsonFile(config.deploymentStatePath, null);
  if (!deployment || deployment.status !== "pending") return;
  guardianState.activationRunning = true;
  let release;
  let restarted = false;
  try {
    // Deferral is not a failed deployment: do not stop web, build, or roll back.
    release = await relayIdleWindow();
    deployment.attempts = Number(deployment.attempts || 0) + 1;
    deployment.status = "activating";
    deployment.activationStartedAt = now();
    writeJsonFile(config.deploymentStatePath, deployment);
    await stopRecognizedPort(config.webPort, "server[\\\\/]web\\.mjs");
    await stopRecognizedPort(config.internalWebPort, "vinext.+\\bstart\\b");
    await buildMain();
    await restartRelay(`Deploying repair ${deployment.repairId}`);
    restarted = true;
    await restartWeb(`Deploying repair ${deployment.repairId}`);
    await waitForServices();
    deployment.status = "healthy";
    deployment.healthyAt = now();
    writeJsonFile(config.deploymentStatePath, deployment);
  } catch (error) {
    if (!release) {
      deployment.deferredReason = error.message;
      writeJsonFile(config.deploymentStatePath, deployment);
      return;
    }
    guardianState.lastError = error.message;
    deployment.activationError = error.message;
    try {
      // A new backend may already be executing work after activation. Never
      // revert its source or restart it while those turns are in flight.
      const releaseRollback = await relayIdleWindow();
      let rollbackRestarted = false;
      try {
        const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
        const dirty = (await git(["status", "--porcelain"])).stdout.trim();
        if (head !== deployment.commitSha || dirty) {
          throw new Error(
            "Cannot automatically roll back because Relay source moved or is dirty",
          );
        }
        await git([
          "-c",
          `user.name=${config.gitAuthorName}`,
          "-c",
          `user.email=${config.gitAuthorEmail}`,
          "revert",
          "--no-edit",
          deployment.commitSha,
        ]);
        await buildMain();
        await restartRelay(`Rolling back repair ${deployment.repairId}`);
        rollbackRestarted = true;
        restarted = true;
        await restartWeb(`Rolling back repair ${deployment.repairId}`);
        await waitForServices();
        deployment.status = "rolled_back";
        deployment.rolledBackAt = now();
      } finally {
        await releaseRollback({ restarted: rollbackRestarted });
      }
    } catch (rollbackError) {
      deployment.status = "rollback_failed";
      deployment.rollbackError = rollbackError.message;
      guardianState.lastError = rollbackError.message;
    }
    writeJsonFile(config.deploymentStatePath, deployment);
  } finally {
    guardianState.activationRunning = false;
    await release?.({ restarted });
  }
}

class FileRepairStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = readJsonFile(filePath, { repairs: [], events: [] });
  }

  save() {
    writeJsonFile(this.filePath, this.state);
  }

  createRepairRun({ opsTurnId = null, incidentId = null, instructions }) {
    const timestamp = now();
    const repair = {
      id: id("guardian-repair-"),
      opsTurnId,
      incidentId,
      status: "queued",
      instructions,
      branchName: null,
      worktreePath: null,
      baseSha: null,
      commitSha: null,
      codexThreadId: null,
      validation: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deployedAt: null,
      rolledBackAt: null,
    };
    this.state.repairs.push(repair);
    this.save();
    return { ...repair };
  }

  getRepairRun(repairId) {
    const found = this.state.repairs.find((item) => item.id === repairId);
    return found ? { ...found } : null;
  }

  updateRepairRun(repairId, changes) {
    const index = this.state.repairs.findIndex((item) => item.id === repairId);
    if (index < 0) return null;
    this.state.repairs[index] = {
      ...this.state.repairs[index],
      ...changes,
      updatedAt: now(),
    };
    this.save();
    return { ...this.state.repairs[index] };
  }

  emit(event) {
    this.state.events.push({
      id: this.state.events.length + 1,
      ...event,
      createdAt: now(),
    });
    this.state.events = this.state.events.slice(-250);
    this.save();
  }
}

const localRestartCoordinator = {
  async requestDeploymentRestart() {
    setImmediate(() => void activatePendingDeployment());
    return { accepted: true };
  },
  async requestRelayRestart(body) {
    return restartRelay(body?.reason);
  },
  async requestWebRestart(body) {
    return restartWeb(body?.reason);
  },
};
const fileRepairStore = new FileRepairStore(guardianRepairStatePath);
const emergencyRepairManager = new RepairManager(
  { config, store: fileRepairStore },
  { restartCoordinator: localRestartCoordinator },
);
const emergencySessionRunner = new CodexSessionRunner(config);

function emergencyThreadRecord({
  id: threadId = id("guardian-thread-"),
  title = "Emergency recovery",
  codexThreadId = null,
  codexModel = config.opsCodexModel,
  codexReasoningEffort = config.opsCodexReasoningEffort,
  codexFastMode = config.opsCodexFastMode,
  clearedThroughSequence = 0,
  createdAt = now(),
  updatedAt = createdAt,
} = {}) {
  return {
    id: threadId,
    title,
    isSystem: threadId === "guardian-emergency",
    clearedThroughSequence,
    codexThreadId,
    status: "idle",
    codexModel,
    codexReasoningEffort,
    codexFastMode,
    createdAt,
    updatedAt,
  };
}

function normalizeEmergencyState(raw) {
  const turns = Array.isArray(raw?.turns)
    ? raw.turns.map((turn) =>
        turn.status === "running"
          ? {
              ...turn,
              status: "failed",
              errorMessage: "Guardian restarted during this turn",
              finishedAt: now(),
            }
          : turn,
      )
    : [];
  if (Array.isArray(raw?.threads) && raw.threads.length) {
    return {
      threads: raw.threads.map((thread) =>
        emergencyThreadRecord({
          ...thread,
          codexThreadId: thread.codexThreadId,
        }),
      ),
      turns,
    };
  }
  return {
    threads: [
      emergencyThreadRecord({
        id: "guardian-emergency",
        title: "Guardian 自动恢复",
        codexThreadId: raw?.threadId || null,
        createdAt: raw?.createdAt || startedAt,
      }),
    ],
    turns: turns.map((turn) => ({
      ...turn,
      threadId: turn.threadId || "guardian-emergency",
    })),
  };
}

let emergencyState = normalizeEmergencyState(
  readJsonFile(emergencyStatePath, {
    threadId: null,
    turns: [],
  }),
);
const emergencyActiveThreads = new Map();
let emergencyScheduling = false;
let emergencyActionChain = Promise.resolve();

function saveEmergencyState() {
  writeJsonFile(emergencyStatePath, emergencyState);
}

function emergencyLogs() {
  let files = [];
  try {
    files = fs
      .readdirSync(config.logDirectory)
      .filter((name) => /\.(?:log|jsonl)$/iu.test(name))
      .map((name) => {
        const filePath = path.join(config.logDirectory, name);
        return { name, filePath, modified: fs.statSync(filePath).mtimeMs };
      })
      .sort((a, b) => b.modified - a.modified)
      .slice(0, 8);
  } catch {
    return [];
  }
  return files.map((file) => {
    try {
      const content = fs.readFileSync(file.filePath, "utf8");
      return { path: file.filePath, tail: content.slice(-10_000) };
    } catch {
      return { path: file.filePath, tail: "[unreadable]" };
    }
  });
}

async function executeEmergencyAction(turn, action, final) {
  switch (action.type) {
    case "relay.restart":
      return restartRelay(action.reason);
    case "web.restart":
      return restartWeb(action.reason);
    case "relay.repair":
      return emergencyRepairManager.run({
        opsTurnId: turn.id,
        instructions:
          action.message ||
          `${final.diagnosis}\nVerification: ${final.verification}`,
      });
    case "guardian.restart":
      setTimeout(() => process.exit(0), 250).unref();
      return { accepted: true };
    default:
      await restartRelay(
        `Emergency action ${action.type} requires the Relay API`,
      );
      return {
        pending: true,
        message: "Relay restart requested; continue the action after recovery",
      };
  }
}

function getEmergencyThread(threadId = "guardian-emergency") {
  return (
    emergencyState.threads.find((thread) => thread.id === threadId) || null
  );
}

function refreshEmergencyThread(threadId) {
  const thread = getEmergencyThread(threadId);
  if (!thread) return null;
  const turns = emergencyState.turns.filter(
    (turn) => turn.threadId === threadId,
  );
  thread.status = turns.some((turn) => turn.status === "running")
    ? "running"
    : turns.some((turn) => turn.status === "queued")
      ? "queued"
      : "idle";
  thread.updatedAt = now();
  return thread;
}

function createEmergencyThread(input) {
  const thread = emergencyThreadRecord(input);
  emergencyState.threads.push(thread);
  saveEmergencyState();
  return thread;
}

function updateEmergencyThread(threadId, changes) {
  const thread = getEmergencyThread(threadId);
  if (!thread) throw new Error("System Codex conversation not found");
  if (["queued", "running"].includes(thread.status)) {
    throw new Error(
      "Wait for the active System Codex turn before changing settings",
    );
  }
  Object.assign(thread, changes, { updatedAt: now() });
  saveEmergencyState();
  return thread;
}

function clearEmergencyThread(threadId) {
  const thread = getEmergencyThread(threadId);
  if (!thread) throw new Error("System Codex conversation not found");
  if (["queued", "running"].includes(thread.status)) {
    throw new Error(
      "Wait for the active System Codex turn before clearing the screen",
    );
  }
  thread.clearedThroughSequence = emergencyState.turns
    .filter((turn) => turn.threadId === threadId)
    .reduce((maximum, turn) => Math.max(maximum, turn.sequence), 0);
  thread.updatedAt = now();
  saveEmergencyState();
  return thread;
}

function serializeEmergencyAction(operation) {
  const execution = emergencyActionChain.then(operation, operation);
  emergencyActionChain = execution.catch(() => undefined);
  return execution;
}

function pumpEmergencyTurns() {
  if (emergencyScheduling) return;
  emergencyScheduling = true;
  try {
    const maximum = Math.max(1, Number(config.opsMaxConcurrentSessions || 4));
    while (emergencyActiveThreads.size < maximum) {
      const turn = emergencyState.turns.find(
        (item) =>
          item.status === "queued" &&
          !emergencyActiveThreads.has(item.threadId),
      );
      if (!turn) break;
      turn.status = "running";
      turn.startedAt = now();
      emergencyActiveThreads.set(turn.threadId, turn.id);
      refreshEmergencyThread(turn.threadId);
      saveEmergencyState();
      void runEmergencyTurn(turn);
    }
  } finally {
    emergencyScheduling = false;
  }
}

async function runEmergencyTurn(turn) {
  const thread = getEmergencyThread(turn.threadId);
  try {
    if (!thread) throw new Error("System Codex conversation not found");
    const prompt = [
      "You are the emergency Guardian Codex. The main Relay API is unavailable.",
      "Diagnose the service and follow the action policy for this turn.",
      "Never delete files, data, logs, branches, worktrees, VMs, checkpoints, tasks, projects, or workers.",
      ...actionPolicyPrompt(turn),
      "Use relay.restart or web.restart for process faults and relay.repair for code faults.",
      "Relay repairs run in an isolated worktree, reject file deletions, validate, commit, deploy, and roll back on failed health checks.",
      "",
      `Operator request: ${turn.userMessage}`,
      "",
      `Guardian state: ${JSON.stringify(guardianState, null, 2)}`,
      `Deployment state: ${JSON.stringify(readJsonFile(config.deploymentStatePath, null), null, 2)}`,
      `Recent logs: ${JSON.stringify(emergencyLogs(), null, 2)}`,
    ].join("\n");
    const result = await emergencySessionRunner.run({
      cwd: config.projectRoot,
      threadId: thread.codexThreadId,
      prompt,
      schemaPath: opsSchemaPath,
      logDirectory: path.join(
        config.logDirectory,
        "guardian",
        "ops-turns",
        thread.id,
      ),
      logName: `${turn.sequence}-${turn.id}`,
      sandbox: "read-only",
      model: thread.codexModel,
      reasoningEffort: thread.codexReasoningEffort,
      fastMode: thread.codexFastMode,
    });
    thread.codexThreadId = result.threadId;
    const policy = suppressUnauthorizedActions(turn, result.final);
    const actionResults = [...policy.suppressed];
    for (const action of policy.actions) {
      try {
        actionResults.push({
          type: action.type,
          status: "completed",
          result: await serializeEmergencyAction(() =>
            executeEmergencyAction(turn, action, result.final),
          ),
        });
      } catch (error) {
        actionResults.push({
          type: action.type,
          status: "failed",
          error: error.message,
        });
      }
    }
    turn.status = "completed";
    turn.final = { ...policy.final, actionResults };
    turn.finishedAt = now();
  } catch (error) {
    turn.status = "failed";
    turn.errorMessage = error.message;
    turn.finishedAt = now();
  } finally {
    emergencyActiveThreads.delete(turn.threadId);
    refreshEmergencyThread(turn.threadId);
    saveEmergencyState();
    queueMicrotask(() => pumpEmergencyTurns());
  }
}

function appendEmergencyTurn(
  message,
  authorName,
  threadId = "guardian-emergency",
) {
  const thread = getEmergencyThread(threadId);
  if (!thread) throw new Error("System Codex conversation not found");
  const sequence =
    emergencyState.turns
      .filter((item) => item.threadId === threadId)
      .reduce((maximum, item) => Math.max(maximum, item.sequence), 0) + 1;
  const turn = {
    id: id("guardian-ops-turn-"),
    threadId,
    sequence,
    trigger: "manual",
    incidentId: null,
    userMessage: message,
    authorName: authorName || "Remote Operator",
    status: "queued",
    final: null,
    errorMessage: null,
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
  };
  emergencyState.turns.push(turn);
  refreshEmergencyThread(threadId);
  saveEmergencyState();
  pumpEmergencyTurns();
  return turn;
}

function recoverySnapshot() {
  const defaultThread =
    getEmergencyThread("guardian-emergency") || emergencyState.threads[0];
  const visibleTurns = emergencyState.turns.filter((turn) => {
    const thread = getEmergencyThread(turn.threadId);
    return thread && turn.sequence > thread.clearedThroughSequence;
  });
  return {
    server: {
      mode: "hyperv",
      version: config.version,
      connected: true,
      schedulerRunning: false,
      recoveryMode: true,
      guardian: {
        ...guardianState,
        port: config.guardianPort,
        startedAt,
      },
      runtime: null,
    },
    projects: [],
    workers: [],
    tasks: [],
    turns: [],
    events: [],
    queue: [],
    stats: {
      projects: 0,
      workers: 0,
      readyWorkers: 0,
      busyWorkers: 0,
      queuedTurns: 0,
      runningTurns: 0,
    },
    ops: {
      thread: defaultThread,
      threads: emergencyState.threads.map((thread) => ({
        ...thread,
        visibleTurnCount: visibleTurns.filter(
          (turn) => turn.threadId === thread.id,
        ).length,
        totalTurnCount: emergencyState.turns.filter(
          (turn) => turn.threadId === thread.id,
        ).length,
      })),
      turns: visibleTurns,
      incidents: [],
      actions: [],
      repairs: fileRepairStore.state.repairs,
    },
  };
}

async function monitor() {
  if (guardianState.monitoring) return;
  guardianState.monitoring = true;
  try {
    const deployment = readJsonFile(config.deploymentStatePath, null);
    if (deployment?.status === "pending") {
      await activatePendingDeployment();
      if (readJsonFile(config.deploymentStatePath, null)?.status !== "pending")
        return;
    }
    const [relay, web] = await Promise.all([
      probe(`http://127.0.0.1:${config.port}/api/health`),
      probe(`http://127.0.0.1:${config.webPort}/`),
    ]);
    guardianState.lastRelayHealth = relay.ok ? now() : null;
    guardianState.lastWebHealth = web.ok ? now() : null;
    guardianState.relayFailures = relay.ok
      ? 0
      : guardianState.relayFailures + 1;
    guardianState.webFailures = web.ok ? 0 : guardianState.webFailures + 1;
    if (
      guardianState.relayFailures >= config.guardianFailureThreshold &&
      !relayRestarting
    ) {
      await restartRelay("Relay health check failed repeatedly");
      guardianState.relayFailures = 0;
    }
    if (
      guardianState.webFailures >= config.guardianFailureThreshold &&
      !webRestarting
    ) {
      await restartWeb("Relay web health check failed repeatedly");
      guardianState.webFailures = 0;
    }
  } catch (error) {
    guardianState.lastError = error.message;
  } finally {
    guardianState.monitoring = false;
  }
}

function recoveryHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Relay Guardian Recovery</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,"Segoe UI",sans-serif;background:#071019;color:#eaf2f8}
    body{margin:0;min-height:100vh;background:radial-gradient(circle at 20% 0,#173a4e,transparent 38%),#071019;padding:28px}
    main{max-width:920px;margin:auto}.card{background:#0e1924;border:1px solid #294052;border-radius:18px;padding:22px;margin:16px 0}
    h1{margin:.2em 0}p{color:#a9bac7;line-height:1.6}button{border:0;border-radius:10px;padding:11px 16px;font-weight:750;background:#63e2af;color:#052116;margin-right:8px}
    textarea{width:100%;min-height:120px;background:#08121b;color:#eaf2f8;border:1px solid #345064;border-radius:12px;padding:12px;box-sizing:border-box}
    pre{white-space:pre-wrap;max-height:360px;overflow:auto;color:#b9cbd8}.warning{color:#ffd27a}
  </style>
</head>
<body><main>
  <p>RELAY RECOVERY PLANE</p><h1>Guardian 独立恢复入口</h1>
  <p>即使 Relay 主进程不可用，此页面仍可拉起服务、恢复网页或启动隔离的 Codex 自修复。</p>
  <section class="card"><h2>服务状态</h2><pre id="health">正在读取…</pre>
    <button onclick="act('restart-relay')">重启 Relay</button>
    <button onclick="act('restart-web')">重启网页</button>
  </section>
  <section class="card"><h2>Emergency Codex</h2>
    <textarea id="message" placeholder="描述要诊断或恢复的问题"></textarea><br><br>
    <button onclick="send()">发送并自动执行</button><pre id="turns"></pre>
  </section>
  <script>
    async function refresh(){
      health.textContent=JSON.stringify(await (await fetch('/api/health')).json(),null,2);
      const snap=await (await fetch('/api/snapshot')).json();
      turns.textContent=JSON.stringify(snap.ops.turns.slice(-8),null,2);
    }
    async function act(name){await fetch('/api/actions/'+name,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});setTimeout(refresh,500)}
    async function send(){const value=message.value.trim();if(!value)return;await fetch('/api/ops/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:value})});message.value='';setTimeout(refresh,500)}
    setInterval(refresh,3000);refresh();
  </script>
</main></body></html>`;
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Pipeline-User",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    });
    response.end();
    return;
  }
  const url = new URL(
    request.url || "/",
    `http://${request.headers.host || "localhost"}`,
  );
  try {
    if (request.method === "GET" && url.pathname === "/") {
      const body = recoveryHtml();
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      response.end(body);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      json(response, 200, {
        ok: true,
        service: "relay-guardian",
        version: config.version,
        startedAt,
        uptimeSeconds: Math.round(process.uptime()),
        relay: {
          reachable: Boolean(guardianState.lastRelayHealth),
          lastHealthyAt: guardianState.lastRelayHealth,
          failures: guardianState.relayFailures,
          restarts: guardianState.relayRestarts,
        },
        web: {
          reachable: Boolean(guardianState.lastWebHealth),
          lastHealthyAt: guardianState.lastWebHealth,
          failures: guardianState.webFailures,
          restarts: guardianState.webRestarts,
        },
        deployment: readJsonFile(config.deploymentStatePath, null),
        lastError: guardianState.lastError,
        now: now(),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/snapshot") {
      json(response, 200, recoverySnapshot());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      response.write(
        `event: ready\ndata: ${JSON.stringify({ now: now(), recoveryMode: true })}\n\n`,
      );
      const heartbeat = setInterval(
        () => response.write(`: guardian ${Date.now()}\n\n`),
        20_000,
      );
      request.on("close", () => clearInterval(heartbeat));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ops/threads") {
      const body = await readBody(request);
      const title = String(body.title || "")
        .trim()
        .slice(0, 120);
      if (!title) throw new Error("title is required");
      const settings = codexTaskSettings(body, {
        codexModel: config.opsCodexModel,
        codexReasoningEffort: config.opsCodexReasoningEffort,
        codexFastMode: config.opsCodexFastMode,
      });
      const thread = createEmergencyThread({ title, ...settings });
      json(response, 201, { ok: true, thread });
      return;
    }
    const opsThreadMutation = url.pathname.match(
      /^\/api\/ops\/threads\/([^/]+)(?:\/(clear))?$/,
    );
    if (opsThreadMutation) {
      const threadId = decodeURIComponent(opsThreadMutation[1]);
      const action = opsThreadMutation[2] || null;
      const current = getEmergencyThread(threadId);
      if (!current) throw new Error("System Codex conversation not found");
      if (request.method === "PATCH" && !action) {
        const body = await readBody(request);
        const settings = codexTaskSettings(body, current);
        const title =
          body.title == null
            ? current.title
            : String(body.title).trim().slice(0, 120);
        if (!title) throw new Error("title is required");
        const thread = updateEmergencyThread(threadId, {
          title,
          ...settings,
        });
        json(response, 200, { ok: true, thread });
        return;
      }
      if (request.method === "POST" && action === "clear") {
        json(response, 200, {
          ok: true,
          thread: clearEmergencyThread(threadId),
        });
        return;
      }
    }
    if (request.method === "POST" && url.pathname === "/api/ops/messages") {
      const body = await readBody(request);
      const message = String(body.message || "").trim();
      if (!message) throw new Error("message is required");
      const turn = appendEmergencyTurn(
        message,
        request.headers["x-pipeline-user"],
        body.threadId || "guardian-emergency",
      );
      json(response, 201, { ok: true, turn });
      return;
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/actions/")) {
      const body = await readBody(request);
      const action = url.pathname.slice("/api/actions/".length);
      if (action === "restart-relay") {
        json(response, 202, {
          ok: true,
          ...(await restartRelay(body.reason)),
        });
        return;
      }
      if (action === "restart-web") {
        json(response, 202, {
          ok: true,
          ...(await restartWeb(body.reason)),
        });
        return;
      }
      if (action === "deployment-restart") {
        json(response, 202, { ok: true, accepted: true });
        setImmediate(() => void activatePendingDeployment());
        return;
      }
      if (action === "restart-guardian") {
        json(response, 202, { ok: true, accepted: true });
        setTimeout(() => process.exit(0), 250).unref();
        return;
      }
    }
    json(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    json(response, error.status || 500, {
      ok: false,
      error: { code: error.code || "GUARDIAN_ERROR", message: error.message },
    });
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.guardianPort, config.guardianHost, () => {
    server.off("error", reject);
    resolve();
  });
});
console.log(
  `Relay Guardian listening on http://${config.guardianHost}:${config.guardianPort}`,
);
for (const thread of emergencyState.threads) {
  refreshEmergencyThread(thread.id);
}
saveEmergencyState();
pumpEmergencyTurns();
await monitor();
const monitorTimer = setInterval(
  () => void monitor(),
  config.guardianIntervalMs,
);

function shutdown() {
  clearInterval(monitorTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
