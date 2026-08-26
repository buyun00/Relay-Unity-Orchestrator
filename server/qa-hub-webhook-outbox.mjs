import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export const QA_HUB_WEBHOOK_SCHEMA_VERSION = "1.0";
export const QA_HUB_WEBHOOK_DELIVERY_PREFIX = "relay-main:event:";
export const QA_HUB_WEBHOOK_RETRYABLE_STATUSES = Object.freeze([
  408,
  425,
  429,
]);

const MAX_EVENT_ID_LENGTH = 200;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_DELIVERY_ID_LENGTH = 255;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const QA_EVENT_TYPE_BY_RELAY_EVENT = new Map([
  ["turn.queued", "submitted"],
  ["turn.prepare", "running"],
  ["turn.resume", "running"],
  ["turn.workspace-established", "running"],
  ["turn.codex", "running"],
  ["turn.delivery", "running"],
  ["turn.needs-input", "needs_input"],
  ["turn.needs_input", "needs_input"],
  ["turn.blocked", "blocked"],
  ["turn.failed", "failed"],
  ["turn.cancelled", "failed"],
  ["turn.delivered", "fix_delivered"],
  ["submitted", "submitted"],
  ["running", "running"],
  ["needs_input", "needs_input"],
  ["blocked", "blocked"],
  ["failed", "failed"],
  ["fix_delivered", "fix_delivered"],
]);

export class QaHubWebhookOutboxError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "QaHubWebhookOutboxError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new QaHubWebhookOutboxError(status, code, message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(400, "INVALID_WEBHOOK", "webhook contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) fail(400, "INVALID_WEBHOOK", "webhook contains an unsupported value");
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalWebhookJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function webhookPayloadDigest(valueOrBytes) {
  const bytes = Buffer.isBuffer(valueOrBytes) || valueOrBytes instanceof Uint8Array
    ? Buffer.from(valueOrBytes)
    : Buffer.from(typeof valueOrBytes === "string" ? valueOrBytes : canonicalWebhookJson(valueOrBytes), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

export function webhookSignature(secret, timestamp, rawBody) {
  if (typeof secret !== "string" || secret.length === 0) fail(500, "WEBHOOK_SECRET_NOT_CONFIGURED", "webhook secret is not configured");
  const bytes = Buffer.isBuffer(rawBody) || rawBody instanceof Uint8Array ? Buffer.from(rawBody) : Buffer.from(String(rawBody), "utf8");
  return `sha256=${createHmac("sha256", secret).update(String(timestamp)).update(".").update(bytes).digest("hex")}`;
}

export const signWebhookPayload = webhookSignature;

export function verifyWebhookSignature({ secret, timestamp, rawBody, signature, now = Date.now(), replayWindowSeconds = 300 }) {
  if (typeof timestamp !== "string" || !/^[0-9]{1,16}$/u.test(timestamp)) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(Math.floor(now / 1_000) - timestampSeconds) > replayWindowSeconds) return false;
  if (typeof signature !== "string" || !/^sha256=[0-9a-f]{64}$/u.test(signature)) return false;
  let expected;
  try {
    expected = webhookSignature(secret, timestamp, rawBody);
  } catch {
    return false;
  }
  const suppliedBytes = Buffer.from(signature, "ascii");
  const expectedBytes = Buffer.from(expected, "ascii");
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function safeString(value, label, max = 512) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value !== value.trim()) {
    fail(400, "INVALID_WEBHOOK", `${label} is invalid`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(400, "INVALID_WEBHOOK", `${label} must be a positive integer`);
  return value;
}

function parseRetryAfter(value, now) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, seconds * 1_000);
  const date = Date.parse(String(value));
  if (!Number.isFinite(date)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - now));
}

function retryableStatus(status) {
  return QA_HUB_WEBHOOK_RETRYABLE_STATUSES.includes(status) || (status >= 500 && status <= 599);
}

function responseHeader(response, name) {
  return response?.headers?.get?.(name) ?? response?.headers?.[name] ?? null;
}

function defaultPayload(event) {
  const data = isObject(event.data) ? event.data : {};
  const payload = {};
  const copy = (targetKey, ...sourceKeys) => {
    for (const sourceKey of sourceKeys) {
      if (data[sourceKey] !== undefined) {
        payload[targetKey] = data[sourceKey];
        return;
      }
      if (event[sourceKey] !== undefined) {
        payload[targetKey] = event[sourceKey];
        return;
      }
    }
  };
  copy("taskId", "taskId");
  copy("turnId", "turnId");
  copy("statusReason", "statusReason", "reason", "errorMessage");
  const sourceEventType = event.sourceEventType ?? event.type ?? event.eventType;
  if (sourceEventType === "turn.delivered" || event.eventType === "fix_delivered") {
    const evidence =
      data.deliveryEvidence ??
      data.delivery ??
      event.deliveryEvidence ??
      {
        pushed: data.pushed,
        verified: data.verified,
        commitSha: data.commitSha,
        remoteSha: data.remoteSha,
        branch: data.branch ?? data.branchName,
        mergeRequestUrl: data.mergeRequestUrl,
      };
    if (isObject(evidence)) {
      payload.deliveryEvidence = {
        pushed: evidence.pushed === true,
        verified: evidence.verified === true,
        commitSha: evidence.commitSha ?? null,
        remoteSha: evidence.remoteSha ?? null,
        branch: evidence.branch ?? null,
        mergeRequestUrl: evidence.mergeRequestUrl ?? null,
      };
    }
  }
  copy("buildExternalId", "buildExternalId", "jobId", "externalId");
  copy("buildProjectKey", "buildProjectKey", "projectKey");
  copy("buildBranch", "buildBranch", "branch");
  copy("buildMode", "buildMode", "mode");
  copy("sourceCommitSha", "sourceCommitSha", "commitSha");
  copy("buildRequirement", "buildRequirement");
  return payload;
}

function safeWebhookPayload(value, eventType) {
  if (!isObject(value)) fail(400, "INVALID_WEBHOOK", "payload must be an object");
  const allowed = new Set([
    "taskId",
    "turnId",
    "statusReason",
    "deliveryEvidence",
    "buildExternalId",
    "buildProjectKey",
    "buildBranch",
    "buildMode",
    "sourceCommitSha",
    "buildRequirement",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(400, "INVALID_WEBHOOK", `payload field ${key} is not allowed`);
  }
  const payload = {};
  for (const key of ["taskId", "turnId", "statusReason", "buildExternalId", "buildProjectKey", "buildBranch", "buildMode", "sourceCommitSha"]) {
    if (value[key] !== undefined) payload[key] = value[key];
  }
  if (payload.statusReason !== undefined && payload.statusReason !== null) safeString(String(payload.statusReason), "statusReason", 5_000);
  if (value.deliveryEvidence !== undefined) {
    const evidence = value.deliveryEvidence;
    if (!isObject(evidence)) fail(400, "INVALID_WEBHOOK", "deliveryEvidence must be an object");
    for (const key of Object.keys(evidence)) {
      if (!["pushed", "verified", "commitSha", "remoteSha", "branch", "mergeRequestUrl"].includes(key)) {
        fail(400, "INVALID_WEBHOOK", `deliveryEvidence field ${key} is not allowed`);
      }
    }
    payload.deliveryEvidence = {
      pushed: evidence.pushed === true,
      verified: evidence.verified === true,
      commitSha: evidence.commitSha ?? null,
      remoteSha: evidence.remoteSha ?? null,
      branch: evidence.branch ?? null,
      mergeRequestUrl: evidence.mergeRequestUrl ?? null,
    };
  }
  if (value.buildRequirement !== undefined) {
    const requirement = value.buildRequirement;
    if (!isObject(requirement)) {
      fail(400, "INVALID_WEBHOOK", "buildRequirement must be an object");
    }
    for (const key of Object.keys(requirement)) {
      if (!["required", "projectKey"].includes(key)) {
        fail(400, "INVALID_WEBHOOK", `buildRequirement field ${key} is not allowed`);
      }
    }
    payload.buildRequirement = {
      required: requirement.required === true,
      projectKey:
        typeof requirement.projectKey === "string"
          ? requirement.projectKey
          : null,
    };
  }
  if (eventType === "fix_delivered") {
    const evidence = payload.deliveryEvidence;
    if (
      !evidence ||
      !payload.buildRequirement ||
      evidence.pushed !== true ||
      evidence.verified !== true ||
      typeof evidence.commitSha !== "string" ||
      !/^[0-9a-f]{40}$/u.test(evidence.commitSha) ||
      typeof evidence.remoteSha !== "string" ||
      !/^[0-9a-f]{40}$/u.test(evidence.remoteSha) ||
      evidence.commitSha !== evidence.remoteSha ||
      typeof evidence.branch !== "string" ||
      evidence.branch.length < 1 ||
      evidence.branch.length > 300
    ) {
      fail(422, "RELAY_DELIVERY_EVIDENCE_INVALID", "fix_delivered evidence is invalid");
    }
  }
  return payload;
}

export function normalizeQaHubWebhookEvent(input, relayInstanceId, now = Date.now()) {
  if (!isObject(input)) fail(400, "INVALID_WEBHOOK", "event must be an object");
  const sourceEventType = safeString(
    input.sourceEventType ?? input.type ?? input.eventType,
    "eventType",
    80,
  );
  const eventType = QA_EVENT_TYPE_BY_RELAY_EVENT.get(sourceEventType);
  if (!eventType) return null;
  const eventId = safeString(String(input.eventId ?? input.id ?? ""), "eventId", MAX_EVENT_ID_LENGTH);
  const handoffId = safeString(String(input.handoffId ?? input.data?.handoffId ?? ""), "handoffId", 200);
  const attemptId = safeString(String(input.attemptId ?? input.data?.attemptId ?? ""), "attemptId", 200);
  const externalRevision = positiveInteger(
    input.externalRevision ?? input.data?.externalRevision ?? 1,
    "externalRevision",
  );
  const occurredAt = input.occurredAt ?? input.createdAt ?? new Date(now).toISOString();
  safeString(occurredAt, "occurredAt", 100);
  if (!Number.isFinite(Date.parse(occurredAt))) fail(400, "INVALID_WEBHOOK", "occurredAt is invalid");
  const derivedDeliveryId = `${relayInstanceId}:event:${eventId}`;
  if (input.deliveryId !== undefined && String(input.deliveryId) !== derivedDeliveryId) {
    fail(400, "INVALID_WEBHOOK", "deliveryId is server controlled");
  }
  const deliveryId = safeString(derivedDeliveryId, "deliveryId", MAX_DELIVERY_ID_LENGTH);
  const payload = safeWebhookPayload(
    input.payload ?? defaultPayload({ ...input, sourceEventType, eventType }),
    eventType,
  );
  const envelope = {
    schemaVersion: QA_HUB_WEBHOOK_SCHEMA_VERSION,
    relayInstanceId,
    eventId,
    deliveryId,
    eventType,
    handoffId,
    attemptId,
    externalRevision,
    occurredAt,
    payload,
  };
  const rawBody = Buffer.from(canonicalWebhookJson(envelope), "utf8");
  if (rawBody.length > MAX_BODY_BYTES) fail(413, "PAYLOAD_TOO_LARGE", "webhook payload is too large");
  return {
    id: `webhook:${deliveryId}`,
    deliveryId,
    idempotencyKey: deliveryId,
    relayInstanceId,
    eventId,
    handoffId,
    attemptId,
    externalRevision,
    eventType,
    occurredAt,
    body: rawBody.toString("utf8"),
    rawBody,
    payloadDigest: webhookPayloadDigest(rawBody),
    status: "pending",
    attemptCount: 0,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    nextAttemptAt: new Date(now).toISOString(),
  };
}

const normalizeEvent = normalizeQaHubWebhookEvent;

function recordDue(record, now) {
  return ["pending", "retrying"].includes(record.status) && Date.parse(record.nextAttemptAt ?? "") <= now;
}

export class MemoryWebhookOutboxAdapter {
  constructor() {
    this.records = new Map();
  }

  async findByDeliveryId(deliveryId) {
    const record = this.records.get(deliveryId);
    return record ? clone(record) : null;
  }

  async findLatestByHandoff(handoffId) {
    const latest = [...this.records.values()]
      .filter((record) => record.handoffId === handoffId)
      .sort((a, b) => b.externalRevision - a.externalRevision || String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    return latest ? clone(latest) : null;
  }

  async enqueue(record) {
    const existing = await this.findByDeliveryId(record.deliveryId);
    if (existing) return existing;
    this.records.set(record.deliveryId, clone(record));
    return clone(record);
  }

  async claim(now = Date.now(), leaseMs = 30_000) {
    const due = [...this.records.values()]
      .filter((record) => recordDue(record, now))
      .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt) || String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const candidate of due) {
      const earlier = [...this.records.values()].some(
        (record) =>
          record.handoffId === candidate.handoffId &&
          record.deliveryId !== candidate.deliveryId &&
          ["pending", "retrying", "sending"].includes(record.status) &&
          (record.externalRevision < candidate.externalRevision ||
            (record.externalRevision === candidate.externalRevision && String(record.createdAt) < String(candidate.createdAt))),
      );
      if (earlier) continue;
      candidate.status = "sending";
      candidate.attemptCount = Number(candidate.attemptCount || 0) + 1;
      candidate.leaseExpiresAt = new Date(now + leaseMs).toISOString();
      candidate.updatedAt = new Date(now).toISOString();
      this.records.set(candidate.deliveryId, candidate);
      return clone(candidate);
    }
    return null;
  }

  async markSent(deliveryId, result = {}) {
    const record = this.records.get(deliveryId);
    if (!record) return null;
    Object.assign(record, {
      status: "sent",
      sentAt: result.sentAt ?? new Date().toISOString(),
      responseStatus: result.status ?? null,
      updatedAt: result.updatedAt ?? new Date().toISOString(),
      leaseExpiresAt: null,
      lastError: null,
    });
    return clone(record);
  }

  async markRetry(deliveryId, result = {}) {
    const record = this.records.get(deliveryId);
    if (!record) return null;
    Object.assign(record, {
      status: "retrying",
      nextAttemptAt: result.nextAttemptAt,
      responseStatus: result.status ?? null,
      lastErrorCode: result.errorCode ?? "WEBHOOK_RETRYABLE_FAILURE",
      lastError: result.error ?? null,
      updatedAt: result.updatedAt ?? new Date().toISOString(),
      leaseExpiresAt: null,
    });
    return clone(record);
  }

  async markDeadLetter(deliveryId, result = {}) {
    const record = this.records.get(deliveryId);
    if (!record) return null;
    Object.assign(record, {
      status: "dead_letter",
      deadLetterAt: result.deadLetterAt ?? new Date().toISOString(),
      responseStatus: result.status ?? null,
      lastErrorCode: result.errorCode ?? "WEBHOOK_PERMANENT_FAILURE",
      lastError: result.error ?? null,
      updatedAt: result.updatedAt ?? new Date().toISOString(),
      leaseExpiresAt: null,
    });
    return clone(record);
  }

  async recoverSending(now = Date.now()) {
    let recovered = 0;
    for (const record of this.records.values()) {
      if (record.status !== "sending") continue;
      record.status = "retrying";
      record.nextAttemptAt = new Date(now).toISOString();
      record.leaseExpiresAt = null;
      record.lastErrorCode = "RELAY_RESTARTED_DURING_WEBHOOK";
      record.updatedAt = new Date(now).toISOString();
      recovered += 1;
    }
    return recovered;
  }

  async list(filters = {}) {
    return [...this.records.values()]
      .filter((record) => !filters.status || record.status === filters.status)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(clone);
  }
}

function endpointUrl(value) {
  if (!value) return null;
  let parsed;
  try {
    parsed = value instanceof URL ? new URL(value.toString()) : new URL(String(value));
  } catch {
    fail(500, "WEBHOOK_ENDPOINT_INVALID", "webhook endpoint is invalid");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    fail(500, "WEBHOOK_ENDPOINT_INVALID", "webhook endpoint must be credential-free HTTP(S)");
  }
  return parsed;
}

async function adapterCall(adapter, names, ...args) {
  for (const name of names) {
    if (typeof adapter?.[name] === "function") return adapter[name](...args);
  }
  return undefined;
}

export class QaHubWebhookOutbox {
  constructor(options = {}) {
    this.store = options.store ?? null;
    this.adapter = options.adapter ?? options.outboxAdapter ?? null;
    this.relayInstanceId = options.relayInstanceId ?? "relay-main";
    this.endpoint = endpointUrl(options.endpoint ?? options.webhookUrl ?? null);
    this.secret = options.secret ?? options.webhookSecret ?? null;
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.clock = options.clock ?? (() => Date.now());
    this.timeoutMs = Math.max(1, Number(options.timeoutMs ?? 5_000));
    this.pollIntervalMs = Math.max(100, Number(options.pollIntervalMs ?? 500));
    this.leaseMs = Math.max(1_000, Number(options.leaseMs ?? 30_000));
    this.retryScheduleMs = Array.isArray(options.retryScheduleMs) && options.retryScheduleMs.length > 0
      ? options.retryScheduleMs.map((value) => Math.max(0, Number(value) || 0))
      : [1_000, 5_000, 30_000, 300_000];
    this.maxAttempts = Math.max(1, Number(options.maxAttempts ?? 8));
    this.bindingResolver = options.bindingResolver ?? options.resolveBinding ?? null;
    this.payloadBuilder = options.payloadBuilder ?? null;
    this.durableSink = null;
    this.memoryAdapter = new MemoryWebhookOutboxAdapter();
    this.running = false;
    this.timer = null;
    this.active = Promise.resolve();
  }

  installDurableSink(sink = null) {
    if (sink && typeof sink === "object" && !Array.isArray(sink)) {
      this.adapter = sink;
      this.durableSink = null;
    } else if (typeof sink === "function") {
      this.durableSink = sink;
    } else if (this.store) {
      this.durableSink =
        this.store.appendQaHubWebhookOutbox?.bind(this.store) ??
        this.store.appendWebhookOutbox?.bind(this.store) ??
        this.store.enqueueWebhookOutbox?.bind(this.store) ??
        null;
      const storeAdapter =
        typeof this.store.qaHubWebhookOutboxAdapter === "function"
          ? this.store.qaHubWebhookOutboxAdapter()
          : this.store.webhookOutboxAdapter;
      this.adapter = storeAdapter ?? this.adapter;
    }
    if (!this.adapter && !this.durableSink) this.adapter = this.memoryAdapter;
    return this;
  }

  get durableAdapter() {
    return this.adapter ?? this.memoryAdapter;
  }

  async recoverSending() {
    return adapterCall(this.durableAdapter, ["recoverSending", "recoverStranded", "recover"], this.clock());
  }

  async findByDeliveryId(deliveryId) {
    return adapterCall(this.durableAdapter, ["findByDeliveryId", "getByDeliveryId", "get"], deliveryId);
  }

  async findLatestByHandoff(handoffId) {
    return adapterCall(this.durableAdapter, ["findLatestByHandoff", "getLatestByHandoff", "latest"], handoffId);
  }

  async bindingFor(event) {
    if (typeof this.bindingResolver === "function") return this.bindingResolver(event);
    if (typeof this.store?.getQaHandoffByTaskId === "function") return this.store.getQaHandoffByTaskId(event.taskId ?? event.data?.taskId);
    if (typeof this.store?.getQaHandoff === "function" && (event.handoffId ?? event.data?.handoffId)) {
      return this.store.getQaHandoff({ qaInstanceId: event.qaInstanceId ?? event.data?.qaInstanceId, handoffId: event.handoffId ?? event.data?.handoffId });
    }
    return event.handoffId || event.data?.handoffId ? {
      handoffId: event.handoffId ?? event.data?.handoffId,
      attemptId: event.attemptId ?? event.data?.attemptId,
      qaInstanceId: event.qaInstanceId ?? event.data?.qaInstanceId,
    } : null;
  }

  async appendRecord(record) {
    if (this.durableSink) return this.durableSink(clone(record));
    const result = await adapterCall(this.durableAdapter, ["enqueue", "append", "insert", "put"], record);
    if (result === undefined && this.durableAdapter === this.memoryAdapter) return this.memoryAdapter.enqueue(record);
    return result ?? record;
  }

  async enqueue(input, binding = null) {
    const resolvedBinding = binding ?? await this.bindingFor(input);
    if (!resolvedBinding) return { queued: false, skipped: "NO_QA_BINDING" };
    const event = { ...input };
    event.handoffId ??= resolvedBinding.handoffId;
    event.attemptId ??= resolvedBinding.attemptId;
    event.qaInstanceId ??= resolvedBinding.qaInstanceId;
    const now = this.clock();
    const normalized = normalizeEvent(event, this.relayInstanceId, now);
    if (!normalized) return { queued: false, skipped: "UNSUPPORTED_EVENT" };
    const existing = await this.findByDeliveryId(normalized.deliveryId);
    if (existing) {
      if (existing.payloadDigest !== normalized.payloadDigest) fail(409, "INTEGRATION_EVENT_CONFLICT", "delivery ID is already bound to another payload");
      return { queued: false, replayed: true, record: clone(existing) };
    }
    const latest = await this.findLatestByHandoff(normalized.handoffId);
    if (latest) {
      if (normalized.externalRevision < latest.externalRevision) return { queued: false, ignored: true, reason: "STALE_REVISION", record: clone(latest) };
      if (normalized.externalRevision === latest.externalRevision) {
        if (latest.payloadDigest !== normalized.payloadDigest) fail(409, "INTEGRATION_EVENT_CONFLICT", "equal revision has a different payload");
        return { queued: false, replayed: true, record: clone(latest) };
      }
    }
    const stored = await this.appendRecord(normalized);
    return { queued: true, replayed: false, record: clone(stored ?? normalized) };
  }

  async notify(event, binding = null) {
    const input = isObject(event) ? { ...event } : {};
    if (typeof this.payloadBuilder === "function") {
      input.payload = await this.payloadBuilder(input, binding);
    }
    return this.enqueue(input, binding);
  }

  headersFor(record, timestamp = Math.floor(this.clock() / 1_000).toString()) {
    if (!this.secret) fail(500, "WEBHOOK_SECRET_NOT_CONFIGURED", "webhook secret is not configured");
    const rawBody = Buffer.from(record.body, "utf8");
    return {
      accept: "application/json",
      "content-type": "application/json; charset=utf-8",
      "Idempotency-Key": record.idempotencyKey,
      "X-Relay-Delivery-Id": record.deliveryId,
      "X-Relay-Event-Id": record.eventId,
      "X-Relay-Timestamp": timestamp,
      "X-Relay-Signature": webhookSignature(this.secret, timestamp, rawBody),
    };
  }

  async sendOne() {
    if (!this.endpoint) return false;
    if (typeof this.fetcher !== "function") fail(503, "WEBHOOK_FETCH_UNAVAILABLE", "webhook fetcher is not configured");
    const record = await adapterCall(this.durableAdapter, ["claim", "claimNext"], this.clock(), this.leaseMs);
    if (!record) return false;
    const now = this.clock();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetcher(this.endpoint.toString(), {
        method: "POST",
        headers: this.headersFor(record, Math.floor(now / 1_000).toString()),
        body: record.body,
        signal: controller.signal,
      });
      if (response.status >= 200 && response.status < 300) {
        await adapterCall(this.durableAdapter, ["markSent", "complete", "accept"], record.deliveryId, {
          status: response.status,
          sentAt: new Date(this.clock()).toISOString(),
        });
        return true;
      }
      const retryAfterMs = parseRetryAfter(responseHeader(response, "retry-after"), now);
      const isRetryable = retryableStatus(response.status);
      const exhausted = Number(record.attemptCount || 0) >= this.maxAttempts;
      const errorCode = isRetryable ? "WEBHOOK_HTTP_RETRYABLE" : "WEBHOOK_HTTP_PERMANENT";
      if (isRetryable && !exhausted) {
        const schedule = this.retryScheduleMs[Math.min(Number(record.attemptCount || 1) - 1, this.retryScheduleMs.length - 1)] ?? 0;
        const delayMs = retryAfterMs ?? schedule;
        await adapterCall(this.durableAdapter, ["markRetry", "retry"], record.deliveryId, {
          status: response.status,
          errorCode,
          nextAttemptAt: new Date(now + Math.min(MAX_RETRY_AFTER_MS, delayMs)).toISOString(),
          updatedAt: new Date(now).toISOString(),
        });
      } else {
        await adapterCall(this.durableAdapter, ["markDeadLetter", "deadLetter", "fail"], record.deliveryId, {
          status: response.status,
          errorCode: exhausted ? "WEBHOOK_RETRY_EXHAUSTED" : errorCode,
          deadLetterAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        });
      }
      return true;
    } catch (error) {
      const exhausted = Number(record.attemptCount || 0) >= this.maxAttempts;
      if (!exhausted) {
        const schedule = this.retryScheduleMs[Math.min(Number(record.attemptCount || 1) - 1, this.retryScheduleMs.length - 1)] ?? 0;
        await adapterCall(this.durableAdapter, ["markRetry", "retry"], record.deliveryId, {
          errorCode: error?.name === "AbortError" ? "WEBHOOK_TIMEOUT" : "WEBHOOK_NETWORK_ERROR",
          nextAttemptAt: new Date(now + schedule).toISOString(),
          updatedAt: new Date(now).toISOString(),
        });
      } else {
        await adapterCall(this.durableAdapter, ["markDeadLetter", "deadLetter", "fail"], record.deliveryId, {
          errorCode: "WEBHOOK_RETRY_EXHAUSTED",
          deadLetterAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        });
      }
      return true;
    } finally {
      clearTimeout(timeout);
    }
  }

  async pumpOnce() {
    return this.sendOne();
  }

  start() {
    if (this.running) return this;
    this.installDurableSink();
    this.running = true;
    void this.recoverSending();
    const schedule = (delayMs) => {
      if (!this.running) return;
      this.timer = setTimeout(() => {
        this.active = this.sendOne()
          .catch(() => false)
          .then((sent) => schedule(sent ? 0 : this.pollIntervalMs));
        this.timer.unref?.();
      }, delayMs);
      this.timer.unref?.();
    };
    schedule(0);
    return this;
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
  }

  async list(filters = {}) {
    return adapterCall(this.durableAdapter, ["list", "listRecords"], filters) ?? [];
  }
}

export function createQaHubWebhookOutbox(options = {}) {
  return new QaHubWebhookOutbox(options);
}
