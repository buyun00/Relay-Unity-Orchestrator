import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DailyAuditLogger,
  requestClientIp,
  requestUserName,
} from "../../server/daily-audit-log.mjs";

function readEntries(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

class FakeResponse extends EventEmitter {
  constructor(statusCode = 200, headers = {}) {
    super();
    this.statusCode = statusCode;
    this.headers = new Map(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    this.writableFinished = false;
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase());
  }

  finish() {
    this.writableFinished = true;
    this.emit("finish");
    this.emit("close");
  }
}

function completionFixture() {
  return {
    event: {
      type: "turn.delivered",
      turnId: "turn-1",
      createdAt: "2026-07-31T04:05:06.000Z",
      data: { verified: true, pushed: true },
    },
    task: {
      id: "task-1",
      number: 42,
      title: "Audit the completed task",
      createdBy: "任务创建人",
    },
    turn: {
      id: "turn-1",
      taskId: "task-1",
      sequence: 2,
      authorName: "轮次作者",
      status: "success",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    },
  };
}

test("daily audit records user/IP access without query values and summarizes delivered work", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-daily-audit-test-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixedNow = new Date("2026-07-31T04:05:06.000Z");
  const logger = new DailyAuditLogger({
    directory,
    timeZone: "Asia/Shanghai",
    now: () => fixedNow,
    rotationIntervalMs: 0,
  });
  const request = {
    method: "GET",
    url: "/api/snapshot?token=must-not-leak&status=running",
    headers: {
      cookie: "relay-user=%E6%B5%8B%E8%AF%95%E7%94%A8%E6%88%B7",
      "cf-connecting-ip": "203.0.113.25",
      "cf-ray": "test-ray",
      host: "relay.example.test",
      referer: "https://relay.example.test/task?secret=must-not-leak",
      "user-agent": "Audit test browser",
    },
    socket: { remoteAddress: "127.0.0.1" },
  };
  const response = new FakeResponse(200, { "content-length": "321" });

  assert.equal(requestUserName(request), "测试用户");
  assert.deepEqual(requestClientIp(request), {
    ip: "203.0.113.25",
    source: "cf-connecting-ip",
  });
  logger.trackAccess(request, response);
  response.finish();
  assert.equal(logger.recordTaskCompletion(completionFixture()), true);
  logger.close();

  const entries = readEntries(logger.currentFilePath);
  const access = entries.find((entry) => entry.type === "access");
  assert.equal(access.user, "测试用户");
  assert.equal(access.ip, "203.0.113.25");
  assert.equal(access.path, "/api/snapshot");
  assert.deepEqual(access.queryKeys, ["token", "status"]);
  assert.equal(access.statusCode, 200);
  assert.equal(access.referer, "https://relay.example.test/task");
  assert.doesNotMatch(JSON.stringify(entries), /must-not-leak/u);

  const completion = entries.find((entry) => entry.type === "task_completed");
  assert.equal(completion.taskOwner, "任务创建人");
  assert.equal(completion.turnAuthor, "轮次作者");
  assert.equal(completion.deliveryVerified, true);

  const summary = entries.findLast((entry) => entry.type === "daily_summary");
  assert.deepEqual(summary.totals, {
    accessCount: 1,
    actualCompletedTaskCount: 1,
    deliveredTurnCount: 1,
    userCount: 3,
  });
  const visitor = summary.users.find((entry) => entry.user === "测试用户");
  assert.deepEqual(visitor.ips, ["203.0.113.25"]);
  assert.equal(visitor.accessCount, 1);
  const owner = summary.users.find((entry) => entry.user === "任务创建人");
  assert.equal(owner.actualCompletedTaskCount, 1);
  assert.deepEqual(owner.actualCompletedTaskIds, ["task-1"]);
  const author = summary.users.find((entry) => entry.user === "轮次作者");
  assert.equal(author.deliveredTurnCount, 1);
  assert.deepEqual(author.deliveredTurnIds, ["turn-1"]);
});

test("daily audit reloads the current file, deduplicates completions, and rolls by configured date", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-daily-audit-rollover-test-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let current = new Date("2026-07-31T15:59:59.000Z");
  const options = {
    directory,
    timeZone: "Asia/Shanghai",
    now: () => current,
    rotationIntervalMs: 0,
  };
  const first = new DailyAuditLogger(options);
  assert.equal(first.currentDate, "2026-07-31");
  assert.equal(first.recordTaskCompletion(completionFixture()), true);
  first.close();

  const resumed = new DailyAuditLogger(options);
  assert.equal(resumed.recordTaskCompletion(completionFixture()), false);
  current = new Date("2026-07-31T16:00:01.000Z");
  resumed.rotate();
  assert.equal(resumed.currentDate, "2026-08-01");
  resumed.close();

  const priorEntries = readEntries(
    path.join(directory, "relay-audit-2026-07-31.log"),
  );
  assert.equal(
    priorEntries.filter((entry) => entry.type === "task_completed").length,
    1,
  );
  const rolloverSummary = priorEntries.findLast(
    (entry) =>
      entry.type === "daily_summary" && entry.reason === "day_rollover",
  );
  assert.equal(rolloverSummary.totals.actualCompletedTaskCount, 1);
  assert.equal(rolloverSummary.totals.deliveredTurnCount, 1);

  const nextEntries = readEntries(
    path.join(directory, "relay-audit-2026-08-01.log"),
  );
  assert.equal(nextEntries[0].type, "day_started");
  assert.equal(nextEntries.at(-1).type, "daily_summary");
});
