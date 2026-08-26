import crypto from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

export const USER_COOKIE_NAME = "relay-user";
const UNKNOWN_USER = "未记录用户";

function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function decodedValue(value) {
  const raw = String(value || "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function normalizeUserName(value, fallback = UNKNOWN_USER) {
  return (
    decodedValue(value)
      .replace(/[\u0000-\u001f\u007f]/gu, "")
      .trim()
      .replace(/\s+/gu, " ")
      .slice(0, 80) || fallback
  );
}

function cookieValue(request, name) {
  const raw = firstHeaderValue(request.headers?.cookie);
  if (!raw) return null;
  for (const part of String(raw).split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

export function requestUserName(request) {
  const explicit = firstHeaderValue(request.headers?.["x-pipeline-user"]);
  if (explicit) return normalizeUserName(explicit);
  const browserUser = cookieValue(request, USER_COOKIE_NAME);
  if (browserUser) return normalizeUserName(browserUser);
  const accessIdentity = firstHeaderValue(
    request.headers?.["cf-access-authenticated-user-email"],
  );
  return normalizeUserName(accessIdentity);
}

function normalizedIp(value) {
  let candidate = String(value || "")
    .trim()
    .replace(/^"|"$/gu, "");
  if (!candidate) return null;
  if (candidate.startsWith("[")) {
    const closingBracket = candidate.indexOf("]");
    if (closingBracket > 0) candidate = candidate.slice(1, closingBracket);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/u.test(candidate)) {
    candidate = candidate.replace(/:\d+$/u, "");
  }
  candidate = candidate.replace(/^::ffff:(?=\d{1,3}(?:\.\d{1,3}){3}$)/u, "");
  candidate = candidate.replace(/%.+$/u, "");
  return isIP(candidate) ? candidate : null;
}

export function requestClientIp(request) {
  const cloudflare = normalizedIp(
    firstHeaderValue(request.headers?.["cf-connecting-ip"]),
  );
  if (cloudflare) return { ip: cloudflare, source: "cf-connecting-ip" };

  const forwarded = String(
    firstHeaderValue(request.headers?.["x-forwarded-for"]) || "",
  )
    .split(",")
    .map((value) => normalizedIp(value))
    .find(Boolean);
  if (forwarded) return { ip: forwarded, source: "x-forwarded-for" };

  const realIp = normalizedIp(firstHeaderValue(request.headers?.["x-real-ip"]));
  if (realIp) return { ip: realIp, source: "x-real-ip" };

  const socketIp = normalizedIp(request.socket?.remoteAddress);
  return { ip: socketIp || "unknown", source: "socket" };
}

function safeHeader(value, limit = 500) {
  return String(firstHeaderValue(value) || "")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, limit);
}

function safeRequestUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl || "/", "http://relay.local");
  } catch {
    return { path: "/", queryKeys: [] };
  }
  return {
    path: parsed.pathname.slice(0, 1_000) || "/",
    queryKeys: [
      ...new Set(
        [...parsed.searchParams.keys()]
          .map((key) => safeHeader(key, 100))
          .filter(Boolean),
      ),
    ].slice(0, 50),
  };
}

function safeReferer(value) {
  const raw = safeHeader(value, 2_000);
  if (!raw) return null;
  try {
    const parsed = new URL(raw, "http://relay.local");
    return `${parsed.origin === "http://relay.local" ? "" : parsed.origin}${parsed.pathname}`.slice(
      0,
      1_000,
    );
  } catch {
    return null;
  }
}

function finiteHeaderNumber(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function sortedCounts(map) {
  return Object.fromEntries(
    [...map.entries()].sort(([left], [right]) =>
      String(left).localeCompare(String(right)),
    ),
  );
}

function newUserSummary(user) {
  return {
    user,
    ips: new Set(),
    firstSeenAt: null,
    lastSeenAt: null,
    accessCount: 0,
    successfulAccessCount: 0,
    failedAccessCount: 0,
    methods: new Map(),
    paths: new Map(),
    userAgents: new Set(),
    actualCompletedTaskIds: new Set(),
    deliveredTurnIds: new Set(),
  };
}

export class DailyAuditLogger {
  constructor({
    directory,
    enabled = true,
    timeZone = "Asia/Shanghai",
    now = () => new Date(),
    rotationIntervalMs = 60_000,
  }) {
    this.enabled = Boolean(enabled);
    this.directory = path.resolve(directory);
    this.timeZone = timeZone;
    this.now = now;
    this.rotationIntervalMs = rotationIntervalMs;
    this.currentDate = null;
    this.currentFilePath = null;
    this.closed = false;
    this.timer = null;
    this.resetSummary();
    if (!this.enabled) return;

    // Fail during startup for an invalid configured time zone instead of
    // silently placing records in an unexpected calendar day.
    this.dateKey(this.now());
    fs.mkdirSync(this.directory, { recursive: true });
    this.openDay(this.now());
    if (this.rotationIntervalMs > 0) {
      this.timer = setInterval(() => this.rotate(), this.rotationIntervalMs);
      this.timer.unref?.();
    }
  }

  dateKey(value) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: this.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(value);
    const values = Object.fromEntries(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    return `${values.year}-${values.month}-${values.day}`;
  }

  resetSummary() {
    this.users = new Map();
    this.accessCount = 0;
    this.completedTaskIds = new Set();
    this.completedTurnIds = new Set();
  }

  userSummary(user) {
    const normalized = normalizeUserName(user);
    if (!this.users.has(normalized)) {
      this.users.set(normalized, newUserSummary(normalized));
    }
    return this.users.get(normalized);
  }

  applyEntry(entry) {
    if (entry.type === "access") {
      this.accessCount += 1;
      const summary = this.userSummary(entry.user);
      summary.accessCount += 1;
      if (entry.ip && entry.ip !== "unknown") summary.ips.add(entry.ip);
      if (!summary.firstSeenAt || entry.timestamp < summary.firstSeenAt) {
        summary.firstSeenAt = entry.timestamp;
      }
      if (!summary.lastSeenAt || entry.timestamp > summary.lastSeenAt) {
        summary.lastSeenAt = entry.timestamp;
      }
      if (entry.statusCode >= 200 && entry.statusCode < 400) {
        summary.successfulAccessCount += 1;
      } else {
        summary.failedAccessCount += 1;
      }
      increment(summary.methods, entry.method);
      increment(summary.paths, entry.path);
      if (entry.userAgent) summary.userAgents.add(entry.userAgent);
      return;
    }

    if (entry.type !== "task_completed") return;
    if (this.completedTurnIds.has(entry.turnId)) return;
    this.completedTurnIds.add(entry.turnId);
    this.completedTaskIds.add(entry.taskId);
    this.userSummary(entry.taskOwner).actualCompletedTaskIds.add(entry.taskId);
    this.userSummary(entry.turnAuthor).deliveredTurnIds.add(entry.turnId);
  }

  loadExistingEntries() {
    if (!fs.existsSync(this.currentFilePath)) return;
    const content = fs.readFileSync(this.currentFilePath, "utf8");
    for (const line of content.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        this.applyEntry(JSON.parse(line));
      } catch {
        // Keep the append-only audit file usable even if a prior process ended
        // while writing its final line.
      }
    }
    if (content && !content.endsWith("\n")) {
      fs.appendFileSync(this.currentFilePath, "\n", "utf8");
    }
  }

  writeEntry(entry, { apply = true } = {}) {
    if (!this.enabled || this.closed) return false;
    try {
      fs.appendFileSync(
        this.currentFilePath,
        `${JSON.stringify(entry)}\n`,
        "utf8",
      );
      if (apply) this.applyEntry(entry);
      return true;
    } catch (error) {
      console.error(
        `Failed to write daily audit log ${this.currentFilePath}: ${error.message}`,
      );
      return false;
    }
  }

  openDay(value) {
    this.currentDate = this.dateKey(value);
    this.currentFilePath = path.join(
      this.directory,
      `relay-audit-${this.currentDate}.log`,
    );
    this.resetSummary();
    const existed =
      fs.existsSync(this.currentFilePath) &&
      fs.statSync(this.currentFilePath).size > 0;
    if (existed) this.loadExistingEntries();
    this.writeEntry(
      {
        schemaVersion: 1,
        type: existed ? "service_resumed" : "day_started",
        date: this.currentDate,
        timeZone: this.timeZone,
        timestamp: value.toISOString(),
      },
      { apply: false },
    );
  }

  ensureDay(value) {
    const nextDate = this.dateKey(value);
    if (nextDate === this.currentDate) return;
    this.writeSummary("day_rollover", value);
    this.openDay(value);
  }

  rotate() {
    if (!this.enabled || this.closed) return;
    const timestamp = this.now();
    this.ensureDay(timestamp);
  }

  trackAccess(request, response, { source = "control-api" } = {}) {
    if (!this.enabled || this.closed) return;
    const startedAt = this.now();
    const startedNs = process.hrtime.bigint();
    const user = requestUserName(request);
    const client = requestClientIp(request);
    const requestUrl = safeRequestUrl(request.url);
    const method = safeHeader(request.method || "GET", 20).toUpperCase();
    const userAgent = safeHeader(request.headers?.["user-agent"]);
    const requestId =
      safeHeader(request.headers?.["x-request-id"], 200) ||
      safeHeader(request.headers?.["cf-ray"], 200) ||
      crypto.randomUUID();
    let recorded = false;

    const record = (aborted) => {
      if (recorded) return;
      recorded = true;
      const finishedAt = this.now();
      const elapsedNs = process.hrtime.bigint() - startedNs;
      const statusCode = Number(response.statusCode || (aborted ? 499 : 200));
      this.recordAccess({
        schemaVersion: 1,
        type: "access",
        timestamp: finishedAt.toISOString(),
        startedAt: startedAt.toISOString(),
        requestId,
        source,
        user,
        ip: client.ip,
        ipSource: client.source,
        method,
        path: requestUrl.path,
        queryKeys: requestUrl.queryKeys,
        statusCode,
        durationMs: Number(elapsedNs / 1_000_000n),
        aborted: Boolean(aborted),
        requestBytes: finiteHeaderNumber(request.headers?.["content-length"]),
        responseBytes: finiteHeaderNumber(
          response.getHeader?.("content-length"),
        ),
        host: safeHeader(request.headers?.host, 300) || null,
        forwardedProto:
          safeHeader(request.headers?.["x-forwarded-proto"], 20) || null,
        referer: safeReferer(request.headers?.referer),
        userAgent: userAgent || null,
        cfRay: safeHeader(request.headers?.["cf-ray"], 200) || null,
      });
    };

    response.once("finish", () => record(false));
    response.once("close", () => {
      if (!response.writableFinished) record(true);
    });
  }

  recordAccess(entry) {
    if (!this.enabled || this.closed) return false;
    const timestamp = new Date(entry.timestamp || this.now());
    this.ensureDay(timestamp);
    return this.writeEntry(entry);
  }

  recordTaskCompletion({ event, task, turn }) {
    if (!this.enabled || this.closed || !event?.turnId || !task || !turn) {
      return false;
    }
    const timestamp = new Date(event.createdAt || this.now());
    this.ensureDay(timestamp);
    if (this.completedTurnIds.has(turn.id)) return false;
    return this.writeEntry({
      schemaVersion: 1,
      type: "task_completed",
      timestamp: timestamp.toISOString(),
      taskId: task.id,
      taskNumber: task.number,
      taskTitle: task.title,
      taskOwner: normalizeUserName(task.createdBy),
      turnId: turn.id,
      turnSequence: turn.sequence,
      turnAuthor: normalizeUserName(turn.authorName),
      commitSha: turn.commitSha || null,
      deliveryVerified: event.data?.verified === true,
      deliveryPushed: event.data?.pushed === true,
    });
  }

  summaryPayload(reason, value) {
    const users = [...this.users.values()]
      .map((summary) => ({
        user: summary.user,
        ips: [...summary.ips].sort(),
        firstSeenAt: summary.firstSeenAt,
        lastSeenAt: summary.lastSeenAt,
        accessCount: summary.accessCount,
        successfulAccessCount: summary.successfulAccessCount,
        failedAccessCount: summary.failedAccessCount,
        methods: sortedCounts(summary.methods),
        paths: sortedCounts(summary.paths),
        userAgents: [...summary.userAgents].sort(),
        actualCompletedTaskCount: summary.actualCompletedTaskIds.size,
        actualCompletedTaskIds: [...summary.actualCompletedTaskIds].sort(),
        deliveredTurnCount: summary.deliveredTurnIds.size,
        deliveredTurnIds: [...summary.deliveredTurnIds].sort(),
      }))
      .sort((left, right) => left.user.localeCompare(right.user, "zh-CN"));
    return {
      schemaVersion: 1,
      type: "daily_summary",
      date: this.currentDate,
      timeZone: this.timeZone,
      timestamp: value.toISOString(),
      reason,
      totals: {
        accessCount: this.accessCount,
        actualCompletedTaskCount: this.completedTaskIds.size,
        deliveredTurnCount: this.completedTurnIds.size,
        userCount: users.length,
      },
      users,
    };
  }

  writeSummary(reason = "manual", value = this.now()) {
    if (!this.enabled || this.closed || !this.currentFilePath) return false;
    return this.writeEntry(this.summaryPayload(reason, value), {
      apply: false,
    });
  }

  close() {
    if (!this.enabled || this.closed) return;
    if (this.timer) clearInterval(this.timer);
    this.writeSummary("service_shutdown", this.now());
    this.closed = true;
  }
}
