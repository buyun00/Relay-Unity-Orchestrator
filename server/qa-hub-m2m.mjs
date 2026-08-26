import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The QA Hub integration deliberately lives behind an adapter boundary.  The
 * Relay database has a mature task/turn store, but its schema is not the
 * integration contract.  Keeping the handoff receipts in an injected adapter
 * lets the HTTP layer add a durable table/transaction without making this
 * module aware of SQLite or of a host path.
 */

export const QA_HUB_M2M_BASE_PATH = "/api/integrations/qa/v1";
export const QA_HUB_HANDOFFS_PATH = `${QA_HUB_M2M_BASE_PATH}/handoffs`;
export const QA_HUB_WEBHOOK_PATH = "/api/v1/integrations/relay/webhooks";
export const QA_HUB_M2M_SCOPES = Object.freeze({
  create: "qa:handoff:create",
  continue: "qa:handoff:continue",
  read: "qa:handoff:read",
});

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const MAX_PROMPT_LENGTH = 20_000;
const MAX_TITLE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 20_000;
const MAX_CRITERIA_LENGTH = 10_000;
const MAX_ATTACHMENT_COUNT = 8;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENT_FILENAME_LENGTH = 255;
const MAX_ATTACHMENT_URL_LENGTH = 4_096;
const MAX_EVENT_SUMMARY_LENGTH = 4_000;

const LOOPBACK_IPV4 = /^127\.(?:\d{1,3}\.){2}\d{1,3}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const QA_INSTANCE_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/u;
const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,15}$/u;
const DEFECT_KEY = /^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "application/json",
  "application/zip",
]);
const FORBIDDEN_INPUT_KEYS = new Set([
  "repo",
  "repoUrl",
  "repository",
  "repositoryUrl",
  "path",
  "projectPath",
  "guestProjectPath",
  "smbPath",
  "worker",
  "workerId",
  "branch",
  "branchName",
  "baseBranch",
]);

export class QaHubM2MError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "QaHubM2MError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(status, code, message, details = undefined) {
  throw new QaHubM2MError(status, code, message, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value, label = "request body") {
  if (!isObject(value)) fail(400, "INVALID_REQUEST", `${label} must be an object`);
  return value;
}

function onlyKeys(value, allowed, label = "request body") {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      if (FORBIDDEN_INPUT_KEYS.has(key)) {
        fail(400, "CLIENT_CONTROL_FIELD_FORBIDDEN", `${key} is server controlled`);
      }
      fail(400, "INVALID_REQUEST", `unexpected property: ${key}`);
    }
  }
  return value;
}

function stringValue(value, label, { min = 1, max = 512, pattern = null } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    fail(400, "INVALID_REQUEST", `${label} is invalid`);
  }
  if (value !== value.trim()) fail(400, "INVALID_REQUEST", `${label} is invalid`);
  if (pattern && !pattern.test(value)) fail(400, "INVALID_REQUEST", `${label} is invalid`);
  return value;
}

function optionalString(value, label, options = {}) {
  if (value === undefined || value === null) return null;
  return stringValue(value, label, options);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(400, "INVALID_REQUEST", `${label} must be a positive integer`);
  }
  return value;
}

function parseJsonBody(value) {
  if (value === undefined || value === null || value === "") return {};
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    try {
      value = Buffer.from(value).toString("utf8");
    } catch {
      fail(400, "INVALID_JSON", "request body must be valid JSON");
    }
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      fail(400, "INVALID_JSON", "request body must be valid JSON");
    }
  }
  return asRecord(value);
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const lowerName = name.toLowerCase();
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value === null ? undefined : value;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function remoteAddressOf(context) {
  return (
    context?.remoteAddress ||
    context?.socket?.remoteAddress ||
    context?.request?.socket?.remoteAddress ||
    context?.request?.remoteAddress ||
    null
  );
}

export function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  const normalized = address.trim().toLowerCase();
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized.startsWith("::ffff:")) return isLoopbackAddress(normalized.slice(7));
  if (!LOOPBACK_IPV4.test(normalized)) return false;
  return normalized.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function tokenDigest(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

function constantTimeTokenEquals(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string") return false;
  const suppliedDigest = tokenDigest(supplied);
  const expectedDigest = tokenDigest(expected);
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function configuredTokenEntries(options) {
  const configured =
    options.tokens ?? options.bearerTokens ?? options.m2mTokens ?? null;
  if (configured instanceof Map) {
    return [...configured.entries()].map(([token, value]) => ({
      token,
      ...(isObject(value) ? value : { scopes: value }),
    }));
  }
  if (Array.isArray(configured)) {
    return configured.map((entry) =>
      typeof entry === "string" ? { token: entry } : entry,
    );
  }
  if (isObject(configured)) {
    return Object.entries(configured).map(([token, value]) => ({
      token,
      ...(isObject(value) ? value : { scopes: value }),
    }));
  }
  if (typeof options.token === "string" || typeof options.bearerToken === "string") {
    return [
      {
        token: options.token ?? options.bearerToken,
        scopes: options.scopes ?? options.allowedScopes ?? [],
        name: options.principalName,
        qaInstanceId: options.qaInstanceId,
      },
    ];
  }
  return [];
}

function scopeSet(value) {
  if (Array.isArray(value)) return new Set(value.filter((entry) => typeof entry === "string"));
  if (typeof value === "string") return new Set(value.split(/\s+/u).filter(Boolean));
  return new Set();
}

function authContext(context) {
  if (context?.headers) return context;
  if (context?.request) return context.request;
  return context || {};
}

function authenticate(options, context, requiredScope, qaInstanceId = null) {
  const request = authContext(context);
  if (!isLoopbackAddress(remoteAddressOf(request))) {
    fail(403, "LOOPBACK_REQUIRED", "QA Hub M2M requests must originate on loopback");
  }

  if (request?.authenticated === true && isObject(request.principal)) {
    const scopes = scopeSet(request.principal.scopes);
    if (!scopes.has(requiredScope)) fail(403, "FORBIDDEN", "scope is not granted");
    if (
      request.principal.qaInstanceId &&
      qaInstanceId &&
      request.principal.qaInstanceId !== qaInstanceId
    ) {
      fail(403, "FORBIDDEN", "machine identity is not bound to this QA instance");
    }
    return request.principal;
  }

  const authorization = headerValue(request?.headers, "authorization");
  const match = typeof authorization === "string" && /^Bearer ([^\s]+)$/u.exec(authorization);
  if (!match) fail(401, "UNAUTHENTICATED", "Bearer authentication is required");
  const supplied = match[1];
  let principal = null;
  for (const entry of configuredTokenEntries(options)) {
    if (!isObject(entry) || typeof entry.token !== "string" || entry.token.length === 0) {
      continue;
    }
    if (!constantTimeTokenEquals(supplied, entry.token)) continue;
    principal = {
      name: typeof entry.name === "string" ? entry.name : "qa-hub",
      scopes: [...scopeSet(entry.scopes ?? entry.scope)],
      ...(typeof entry.qaInstanceId === "string"
        ? { qaInstanceId: entry.qaInstanceId }
        : {}),
    };
    break;
  }
  if (!principal) fail(401, "UNAUTHENTICATED", "Bearer authentication failed");
  if (!principal.scopes.includes(requiredScope)) {
    fail(403, "FORBIDDEN", "scope is not granted");
  }
  if (principal.qaInstanceId && qaInstanceId && principal.qaInstanceId !== qaInstanceId) {
    fail(403, "FORBIDDEN", "machine identity is not bound to this QA instance");
  }
  return principal;
}

function canonicalize(value, parentKey = null) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(400, "INVALID_REQUEST", "payload contains a non-finite number");
    return value;
  }
  if (typeof value === "undefined") fail(400, "INVALID_REQUEST", "payload contains undefined");
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, parentKey));
  if (!isObject(value)) fail(400, "INVALID_REQUEST", "payload contains an unsupported value");
  const result = {};
  for (const key of Object.keys(value).sort()) {
    // Signed attachment URLs rotate.  Their metadata remains covered by the
    // hash, while the URL is intentionally not part of the idempotency hash.
    if (parentKey === "selectedAttachments" && key === "downloadUrl") continue;
    result[key] = canonicalize(value[key], key);
  }
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function canonicalPayloadHash(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function clone(value) {
  if (value === undefined) return value;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Buffers and adapter-specific values are handled by the fallback below.
    }
  }
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(clone);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
  }
  return value;
}

function parseAttachment(value, index, limits = {}) {
  const attachment = asRecord(value, `selectedAttachments[${index}]`);
  onlyKeys(
    attachment,
    new Set([
      "attachmentId",
      "filename",
      "mediaType",
      "contentType",
      "size",
      "sha256",
      "downloadUrl",
      "contentBase64",
    ]),
    `selectedAttachments[${index}]`,
  );
  const attachmentId = stringValue(attachment.attachmentId, "attachmentId", {
    max: 200,
    pattern: SAFE_ID,
  });
  const filename = stringValue(attachment.filename, "filename", {
    max: MAX_ATTACHMENT_FILENAME_LENGTH,
  });
  const mediaType = stringValue(
    attachment.mediaType ?? attachment.contentType,
    "mediaType",
    { max: 100 },
  );
  if (!MEDIA_TYPES.has(mediaType)) fail(400, "INVALID_REQUEST", "mediaType is not allowed");
  const size = positiveInteger(attachment.size, "attachment size");
  const maxBytes = limits.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES;
  if (size > maxBytes) fail(413, "PAYLOAD_TOO_LARGE", "attachment is too large");
  const sha256 = stringValue(attachment.sha256, "sha256", { max: 64, pattern: SHA256 });
  const hasUrl = attachment.downloadUrl !== undefined;
  const hasInlineBytes = attachment.contentBase64 !== undefined;
  if (!hasUrl && !hasInlineBytes) {
    fail(400, "INVALID_REQUEST", "attachment requires downloadUrl or contentBase64");
  }
  if (hasUrl && hasInlineBytes) {
    fail(400, "INVALID_REQUEST", "attachment cannot contain both downloadUrl and contentBase64");
  }
  let downloadUrl = null;
  if (hasUrl) {
    downloadUrl = stringValue(attachment.downloadUrl, "downloadUrl", {
      max: MAX_ATTACHMENT_URL_LENGTH,
    });
    let parsedUrl;
    try {
      parsedUrl = new URL(downloadUrl);
    } catch {
      fail(400, "INVALID_REQUEST", "downloadUrl must be an absolute URL");
    }
    if ((parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") || parsedUrl.username || parsedUrl.password) {
      fail(400, "INVALID_REQUEST", "downloadUrl must be a credential-free HTTP(S) URL");
    }
  }
  let contentBase64 = null;
  if (hasInlineBytes) {
    contentBase64 = stringValue(attachment.contentBase64, "contentBase64", {
      max: Math.ceil((maxBytes * 4) / 3) + 16,
    });
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(contentBase64) || contentBase64.length % 4 !== 0) {
      fail(400, "INVALID_REQUEST", "contentBase64 is invalid");
    }
    let decoded;
    try {
      decoded = Buffer.from(contentBase64, "base64");
    } catch {
      fail(400, "INVALID_REQUEST", "contentBase64 is invalid");
    }
    if (!decoded.length || decoded.length > maxBytes) fail(413, "PAYLOAD_TOO_LARGE", "attachment is too large");
    if (decoded.length !== size) fail(422, "ATTACHMENT_SIZE_MISMATCH", "attachment size does not match metadata");
    if (createHash("sha256").update(decoded).digest("hex") !== sha256) {
      fail(422, "ATTACHMENT_HASH_MISMATCH", "attachment hash does not match metadata");
    }
  }
  return Object.freeze({ attachmentId, filename, mediaType, size, sha256, downloadUrl, contentBase64 });
}

function parseCreateBody(value, limits = {}) {
  const body = parseJsonBody(value);
  onlyKeys(body, new Set(["qaInstanceId", "handoffId", "attemptId", "defect", "selectedAttachments"]));
  const qaInstanceId = stringValue(body.qaInstanceId, "qaInstanceId", {
    max: 64,
    pattern: QA_INSTANCE_ID,
  });
  const handoffId = stringValue(body.handoffId, "handoffId", { max: 200, pattern: SAFE_ID });
  const attemptId = stringValue(body.attemptId, "attemptId", { max: 200, pattern: SAFE_ID });
  const defect = asRecord(body.defect, "defect");
  onlyKeys(
    defect,
    new Set(["id", "key", "revision", "projectKey", "title", "description", "severity", "verificationCriteria"]),
    "defect",
  );
  const parsedDefect = Object.freeze({
    id: stringValue(defect.id, "defect.id", { max: 200, pattern: SAFE_ID }),
    key: stringValue(defect.key, "defect.key", { max: 32, pattern: DEFECT_KEY }),
    revision: positiveInteger(defect.revision, "defect.revision"),
    projectKey: stringValue(defect.projectKey, "defect.projectKey", { max: 16, pattern: PROJECT_KEY }),
    title: stringValue(defect.title, "defect.title", { max: MAX_TITLE_LENGTH }),
    description: stringValue(defect.description, "defect.description", { max: MAX_DESCRIPTION_LENGTH }),
    severity: stringValue(defect.severity, "defect.severity", { max: 2, pattern: /^S[0-4]$/u }),
    verificationCriteria: stringValue(defect.verificationCriteria, "defect.verificationCriteria", {
      max: MAX_CRITERIA_LENGTH,
    }),
  });
  const selectedAttachments = body.selectedAttachments ?? [];
  if (!Array.isArray(selectedAttachments) || selectedAttachments.length > MAX_ATTACHMENT_COUNT) {
    fail(400, "INVALID_REQUEST", "selectedAttachments must contain at most eight entries");
  }
  return Object.freeze({
    qaInstanceId,
    handoffId,
    attemptId,
    defect: parsedDefect,
    selectedAttachments: Object.freeze(selectedAttachments.map((entry, index) => parseAttachment(entry, index, limits))),
  });
}

function parseContinueBody(value, handoffId, limits = {}) {
  const body = parseJsonBody(value);
  onlyKeys(body, new Set(["qaInstanceId", "actionId", "attemptId", "prompt", "selectedAttachments"]));
  const qaInstanceId = stringValue(body.qaInstanceId, "qaInstanceId", {
    max: 64,
    pattern: QA_INSTANCE_ID,
  });
  const actionId = stringValue(body.actionId, "actionId", { max: 200, pattern: SAFE_ID });
  const attemptId = stringValue(body.attemptId, "attemptId", { max: 200, pattern: SAFE_ID });
  const prompt = stringValue(body.prompt, "prompt", { max: MAX_PROMPT_LENGTH });
  const selectedAttachments = body.selectedAttachments ?? [];
  if (!Array.isArray(selectedAttachments) || selectedAttachments.length > MAX_ATTACHMENT_COUNT) {
    fail(400, "INVALID_REQUEST", "selectedAttachments must contain at most eight entries");
  }
  return Object.freeze({
    qaInstanceId,
    handoffId: stringValue(handoffId, "handoffId", { max: 200, pattern: SAFE_ID }),
    actionId,
    attemptId,
    prompt,
    selectedAttachments: Object.freeze(selectedAttachments.map((entry, index) => parseAttachment(entry, index, limits))),
  });
}

function requestEnvelope(first, second = {}) {
  const looksLikeRequest =
    isObject(first) &&
    (Object.hasOwn(first, "body") || Object.hasOwn(first, "headers") || Object.hasOwn(first, "remoteAddress") || Object.hasOwn(first, "request"));
  if (looksLikeRequest) {
    const context = first;
    return {
      context,
      body: context.body,
      headers: context.headers,
      idempotencyKey: context.idempotencyKey,
    };
  }
  return {
    context: second || {},
    body: first,
    headers: second?.headers,
    idempotencyKey: second?.idempotencyKey,
  };
}

function idempotencyKey(headers, explicit) {
  const key = explicit ?? headerValue(headers, "idempotency-key");
  if (typeof key !== "string" || key.length < 1 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    fail(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key is required");
  }
  if (!/^[A-Za-z0-9._:-]+$/u.test(key)) fail(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key is invalid");
  return key;
}

function idempotencyStore(options) {
  return options.idempotency ?? options.receipts ?? options.handoffStore ?? null;
}

async function adapterGet(adapter, key, kind) {
  if (!adapter) return null;
  if (typeof adapter.getIdempotency === "function") return adapter.getIdempotency(key, kind);
  if (typeof adapter.getReceipt === "function") return adapter.getReceipt(key, kind);
  if (typeof adapter.get === "function") return adapter.get(key, kind);
  return null;
}

async function adapterPut(adapter, key, value, kind) {
  if (!adapter) return;
  if (typeof adapter.putIdempotency === "function") return adapter.putIdempotency(key, value, kind);
  if (typeof adapter.putReceipt === "function") return adapter.putReceipt(key, value, kind);
  if (typeof adapter.put === "function") return adapter.put(key, value, kind);
}

async function adapterGetBinding(adapter, qaInstanceId, handoffId) {
  if (!adapter) return null;
  if (typeof adapter.getHandoff === "function") return adapter.getHandoff({ qaInstanceId, handoffId });
  if (typeof adapter.getBinding === "function") return adapter.getBinding({ qaInstanceId, handoffId });
  return null;
}

async function adapterPutBinding(adapter, binding) {
  if (!adapter) return;
  if (typeof adapter.putHandoff === "function") return adapter.putHandoff(binding);
  if (typeof adapter.putBinding === "function") return adapter.putBinding(binding);
  if (typeof adapter.saveHandoff === "function") return adapter.saveHandoff(binding);
}

async function readAttachmentBytes(hook, attachment, context) {
  if (attachment.contentBase64 !== null) {
    const bytes = Buffer.from(attachment.contentBase64, "base64");
    if (bytes.length !== attachment.size) fail(422, "ATTACHMENT_SIZE_MISMATCH", "attachment size does not match metadata");
    return Object.freeze({
      attachmentId: attachment.attachmentId,
      filename: attachment.filename,
      contentType: attachment.mediaType,
      mediaType: attachment.mediaType,
      size: bytes.length,
      sha256: attachment.sha256,
      bytes,
    });
  }
  if (typeof hook !== "function") fail(503, "ATTACHMENT_BYTES_UNAVAILABLE", "attachment bytes hook is not configured");
  let result;
  try {
    result = await hook(
      {
        attachment,
        url: attachment.downloadUrl,
        qaInstanceId: context.qaInstanceId,
        handoffId: context.handoffId,
        actionId: context.actionId ?? null,
        projectKey: context.projectKey,
      },
      context,
    );
  } catch (error) {
    fail(502, "ATTACHMENT_FETCH_FAILED", "selected attachment could not be fetched", {
      cause: error instanceof Error ? error.message.slice(0, 200) : "attachment hook failed",
    });
  }
  const bytes = Buffer.isBuffer(result)
    ? result
    : result instanceof Uint8Array
      ? Buffer.from(result)
      : isObject(result) && (Buffer.isBuffer(result.bytes) || result.bytes instanceof Uint8Array)
        ? Buffer.from(result.bytes)
        : null;
  if (!bytes) fail(502, "ATTACHMENT_BYTES_INVALID", "attachment hook must return bytes");
  if (bytes.length !== attachment.size) fail(422, "ATTACHMENT_SIZE_MISMATCH", "attachment size does not match metadata");
  if (bytes.length > MAX_ATTACHMENT_BYTES) fail(413, "PAYLOAD_TOO_LARGE", "attachment is too large");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== attachment.sha256) fail(422, "ATTACHMENT_HASH_MISMATCH", "attachment hash does not match metadata");
  return Object.freeze({
    attachmentId: attachment.attachmentId,
    filename: attachment.filename,
    contentType: attachment.mediaType,
    mediaType: attachment.mediaType,
    size: bytes.length,
    sha256: digest,
    bytes,
  });
}

async function prepareAttachments(attachments, hook, context) {
  const total = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  const maxTotalBytes = context.maxTotalAttachmentBytes ?? MAX_TOTAL_ATTACHMENT_BYTES;
  if (total > maxTotalBytes) fail(413, "PAYLOAD_TOO_LARGE", "attachments are too large in total");
  const prepared = [];
  try {
    for (const attachment of attachments) prepared.push(await readAttachmentBytes(hook, attachment, context));
    return Object.freeze(prepared);
  } catch (error) {
    for (const attachment of prepared) {
      try {
        attachment.cleanup?.();
      } catch {
        // Cleanup is best effort; no Store mutation has happened yet.
      }
    }
    throw error;
  }
}

function attachmentFilename(filename) {
  const basename = path.basename(filename).replace(/[^A-Za-z0-9._-]/gu, "_");
  return basename || "attachment.bin";
}

function materializePreparedAttachments(prepared, uploadDirectory) {
  if (!uploadDirectory) return prepared.map((attachment) => ({ ...attachment }));
  const written = [];
  try {
    fs.mkdirSync(uploadDirectory, { recursive: true });
    for (const attachment of prepared) {
      const diskPath = path.join(
        uploadDirectory,
        `${randomUUID()}-${attachmentFilename(attachment.filename)}`,
      );
      fs.writeFileSync(diskPath, attachment.bytes, { flag: "wx" });
      written.push(diskPath);
    }
    return prepared.map((attachment, index) => ({
      filename: attachment.filename,
      path: written[index],
      contentType: attachment.contentType,
      size: attachment.size,
      sha256: attachment.sha256,
      attachmentId: attachment.attachmentId,
      // The bytes are retained for adapters that do not use Relay's Store
      // attachment writer.  The ordinary Store consumes path/contentType.
      bytes: attachment.bytes,
    }));
  } catch (error) {
    for (const diskPath of written) {
      try {
        fs.rmSync(diskPath, { force: true });
      } catch {
        // Best effort; no task mutation has happened yet.
      }
    }
    fail(500, "ATTACHMENT_PERSIST_FAILED", "selected attachment could not be staged");
  }
}

function cleanupPreparedAttachments(prepared) {
  for (const attachment of prepared || []) {
    if (!attachment?.path) continue;
    try {
      fs.rmSync(attachment.path, { force: true });
    } catch {
      // Best effort cleanup.  The Store transaction remains the authority.
    }
  }
}

function normalizeCreateResult(result) {
  const source = isObject(result) ? result : {};
  const task = isObject(source.task) ? source.task : source;
  const turn = isObject(source.turn)
    ? source.turn
    : isObject(source.initialTurn)
      ? source.initialTurn
      : null;
  const taskId = task.id ?? task.taskId ?? source.taskId;
  const turnId = turn?.id ?? turn?.turnId ?? source.initialTurnId ?? source.turnId;
  if (taskId === undefined || taskId === null || turnId === undefined || turnId === null) {
    fail(500, "M2M_STORE_INVALID_RESULT", "task creation did not return stable task and turn IDs");
  }
  return {
    taskId: String(taskId),
    initialTurnId: String(turnId),
    status: typeof (turn?.status ?? task.status ?? source.status) === "string"
      ? (turn?.status ?? task.status ?? source.status)
      : "queued",
    task,
    turn,
  };
}

function normalizeAppendResult(result) {
  const source = isObject(result) ? result : {};
  const turn = isObject(source.turn) ? source.turn : source;
  const turnId = turn.id ?? turn.turnId ?? source.turnId;
  if (turnId === undefined || turnId === null) fail(500, "M2M_STORE_INVALID_RESULT", "turn append did not return a stable turn ID");
  return {
    turnId: String(turnId),
    status: typeof (turn.status ?? source.status) === "string" ? (turn.status ?? source.status) : "queued",
    turn,
  };
}

function publicBinding(binding) {
  return {
    qaInstanceId: binding.qaInstanceId,
    handoffId: binding.handoffId,
    attemptId: binding.attemptId,
    defectId: binding.defectId,
    defectRevision: binding.defectRevision,
    projectKey: binding.projectKey,
    taskId: String(binding.taskId),
    initialTurnId: String(binding.initialTurnId),
    requestHash: binding.requestHash,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

function redactUnsafe(value, key = "") {
  if (value === null || typeof value !== "object") return value;
  if (/token|secret|password|credential|authorization|cookie|smbpath|guestprojectpath|repourl|repositoryurl|projectpath|filepath|file_path|(^|_)path$/iu.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((entry) => redactUnsafe(entry)).filter((entry) => entry !== undefined);
  return Object.fromEntries(
    Object.entries(value)
      .map(([entryKey, entry]) => [entryKey, redactUnsafe(entry, entryKey)])
      .filter(([, entry]) => entry !== undefined),
  );
}

function defaultQueryResult(store, binding) {
  const task = typeof store?.getTask === "function" ? store.getTask(binding.taskId) : null;
  const turns = typeof store?.listTaskTurnsWithAttachments === "function"
    ? store.listTaskTurnsWithAttachments(binding.taskId)
    : typeof store?.listTaskTurns === "function"
      ? store.listTaskTurns(binding.taskId)
      : [];
  const events = typeof store?.listTaskEvents === "function" ? store.listTaskEvents(binding.taskId) : [];
  return { task, turns, events };
}

export class QaHubM2MService {
  constructor(options = {}) {
    this.options = options;
    this.store = options.store ?? {};
    this.scheduler = options.scheduler ?? null;
    this.relayInstanceId = options.relayInstanceId ?? "relay-main";
    this.create = options.create ?? this.store.createTask?.bind(this.store);
    this.append = options.append ?? this.store.appendTurn?.bind(this.store);
    this.queryAdapter = options.queryAdapter ?? options.query ?? null;
    this.attachmentBytes = options.attachmentBytes ?? options.fetchAttachmentBytes ?? null;
    this.idempotency = idempotencyStore(options);
    this.bindings = options.bindings ?? options.handoffStore ?? null;
    this.projectResolver = options.resolveProject ?? options.projectResolver ?? null;
    this.allowedProjects =
      options.projectMap ??
      options.allowedProjects ??
      options.projectAllowlist ??
      options.projects ??
      null;
    this.maxAttachmentBytes = Number.isSafeInteger(options.maxAttachmentBytes) && options.maxAttachmentBytes > 0
      ? options.maxAttachmentBytes
      : MAX_ATTACHMENT_BYTES;
    this.maxTotalAttachmentBytes = Number.isSafeInteger(options.maxTotalAttachmentBytes) && options.maxTotalAttachmentBytes > 0
      ? options.maxTotalAttachmentBytes
      : MAX_TOTAL_ATTACHMENT_BYTES;
    this.uploadDirectory = options.uploadDirectory ?? options.attachmentDirectory ?? null;
    this.transaction = options.transaction ?? null;
    this.atomicPersistence = options.atomicPersistence ?? null;
    this.clock = options.clock ?? (() => Date.now());
    this.now = options.now ?? (() => new Date(this.clock()).toISOString());
    this.inFlight = new Map();
    this.localReceipts = new Map();
    this.localBindings = new Map();
  }

  authenticate(context, requiredScope, qaInstanceId = null) {
    return authenticate(this.options, context, requiredScope, qaInstanceId);
  }

  async resolveProject(projectKey) {
    if (typeof this.projectResolver === "function") {
      const result = await this.projectResolver(projectKey);
      if (!result) fail(403, "PROJECT_NOT_ALLOWED", "project is not allowlisted");
      return isObject(result) ? result : { id: String(result), projectKey };
    }
    const allowlist = this.allowedProjects;
    if (allowlist instanceof Map) {
      const result = allowlist.get(projectKey);
      if (!result) fail(403, "PROJECT_NOT_ALLOWED", "project is not allowlisted");
      return isObject(result) ? result : { id: String(result), projectKey };
    }
    if (isObject(allowlist)) {
      const result = allowlist[projectKey];
      if (!result) fail(403, "PROJECT_NOT_ALLOWED", "project is not allowlisted");
      return isObject(result) ? result : { id: String(result), projectKey };
    }
    if (allowlist instanceof Set || Array.isArray(allowlist)) {
      if (!new Set(allowlist).has(projectKey)) fail(403, "PROJECT_NOT_ALLOWED", "project is not allowlisted");
      return { id: projectKey, projectKey };
    }
    fail(403, "PROJECT_NOT_ALLOWED", "project allowlist is not configured");
  }

  async getIdempotency(key, kind) {
    const external = await adapterGet(this.idempotency, key, kind);
    if (external) return external;
    return this.localReceipts.get(`${kind}:${key}`) ?? null;
  }

  async putIdempotency(key, value, kind) {
    await adapterPut(this.idempotency, key, value, kind);
    this.localReceipts.set(`${kind}:${key}`, clone(value));
  }

  async getBinding(qaInstanceId, handoffId) {
    const external = await adapterGetBinding(this.bindings, qaInstanceId, handoffId);
    if (external) return external;
    return this.localBindings.get(`${qaInstanceId}:${handoffId}`) ?? null;
  }

  async putBinding(binding) {
    await adapterPutBinding(this.bindings, binding);
    this.localBindings.set(`${binding.qaInstanceId}:${binding.handoffId}`, clone(binding));
  }

  async executeIdempotent(kind, key, requestHash, operation) {
    const existing = await this.getIdempotency(key, kind);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        fail(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "Idempotency-Key is already bound to another payload");
      }
      return { ...clone(existing.response), replayed: true };
    }
    const inFlightKey = `${kind}:${key}`;
    const running = this.inFlight.get(inFlightKey);
    if (running) {
      const result = await running;
      if (result.requestHash !== requestHash) {
        fail(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "Idempotency-Key is already bound to another payload");
      }
      return { ...clone(result.response), replayed: true };
    }
    const promise = (async () => {
      const race = await this.getIdempotency(key, kind);
      if (race) {
        if (race.requestHash !== requestHash) fail(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "Idempotency-Key is already bound to another payload");
        return race;
      }
      const response = await operation();
      const receipt = { requestHash, response: clone(response) };
      await this.putIdempotency(key, receipt, kind);
      return receipt;
    })();
    this.inFlight.set(inFlightKey, promise);
    try {
      const result = await promise;
      return { ...clone(result.response), replayed: false };
    } finally {
      if (this.inFlight.get(inFlightKey) === promise) this.inFlight.delete(inFlightKey);
    }
  }

  async fetchAttachments(input, projectKey) {
    const bytes = await prepareAttachments(input.selectedAttachments, this.attachmentBytes, {
      ...input,
      projectKey,
      maxAttachmentBytes: this.maxAttachmentBytes,
      maxTotalAttachmentBytes: this.maxTotalAttachmentBytes,
    });
    return materializePreparedAttachments(bytes, this.uploadDirectory);
  }

  async invokeCreate(input) {
    if (typeof this.create !== "function") fail(503, "M2M_CREATE_NOT_CONFIGURED", "Relay task creation adapter is not configured");
    try {
      const result = await this.create(input);
      return normalizeCreateResult(result);
    } catch (error) {
      cleanupPreparedAttachments(input.preparedAttachments);
      throw error;
    }
  }

  async invokeAppend(taskId, input) {
    if (typeof this.append !== "function") fail(503, "M2M_APPEND_NOT_CONFIGURED", "Relay turn append adapter is not configured");
    const result = await this.append(taskId, input);
    return normalizeAppendResult(result);
  }

  async createHandoff(first, second = {}) {
    const envelope = requestEnvelope(first, second);
    const input = parseCreateBody(envelope.body, { maxAttachmentBytes: this.maxAttachmentBytes });
    const principal = this.authenticate({ ...envelope.context, headers: envelope.headers }, QA_HUB_M2M_SCOPES.create, input.qaInstanceId);
    const key = idempotencyKey(envelope.headers, envelope.idempotencyKey);
    const expectedKey = `qa:${input.qaInstanceId}:handoff:${input.handoffId}`;
    if (key !== expectedKey) fail(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key does not match the handoff");
    const requestHash = canonicalPayloadHash(input);
    const project = await this.resolveProject(input.defect.projectKey);
    const existingBinding = await this.getBinding(input.qaInstanceId, input.handoffId);
    if (existingBinding && existingBinding.requestHash !== requestHash) {
      fail(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "handoff is already bound to another payload");
    }
    return this.executeIdempotent("create", key, requestHash, async () => {
      const attachments = await this.fetchAttachments(input, input.defect.projectKey);
      const createInput = {
        projectId: String(project.id ?? project.projectId ?? input.defect.projectKey),
        projectKey: input.defect.projectKey,
        title: input.defect.title,
        message: [
          `QA defect ${input.defect.key}: ${input.defect.title}`,
          input.defect.description,
          `Verification criteria: ${input.defect.verificationCriteria}`,
        ].join("\n\n").slice(0, MAX_EVENT_SUMMARY_LENGTH + MAX_DESCRIPTION_LENGTH),
        idempotencyKey: key,
        userName: principal.name || "QA Hub",
        preparedAttachments: attachments,
        qa: {
          qaInstanceId: input.qaInstanceId,
          handoffId: input.handoffId,
          attemptId: input.attemptId,
          defectId: input.defect.id,
          defectRevision: input.defect.revision,
          defectKey: input.defect.key,
          projectKey: input.defect.projectKey,
        },
        // Deliberately no repository/path/worker/branch fields.  Those are
        // selected by the server-side project configuration and Store.
      };
      let atomicBinding = null;
      createInput.onCreatedInTransaction = ({ task, turn }) => {
        if (typeof this.atomicPersistence?.persistCreate !== "function") return;
        const createdInTransaction = normalizeCreateResult({ task, turn });
        const timestamp = this.now();
        atomicBinding = {
          qaInstanceId: input.qaInstanceId,
          handoffId: input.handoffId,
          attemptId: input.attemptId,
          defectId: input.defect.id,
          defectRevision: input.defect.revision,
          projectKey: input.defect.projectKey,
          projectId: createInput.projectId,
          taskId: createdInTransaction.taskId,
          initialTurnId: createdInTransaction.initialTurnId,
          requestHash,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const response = {
          relayInstanceId: this.relayInstanceId,
          handoffId: input.handoffId,
          attemptId: input.attemptId,
          taskId: createdInTransaction.taskId,
          turnId: createdInTransaction.initialTurnId,
          initialTurnId: createdInTransaction.initialTurnId,
          status: createdInTransaction.status,
          branchName: task?.branchName ?? null,
          threadId: task?.codexThreadId ?? null,
          workspace: {
            projectId: createInput.projectId,
            branchName: task?.branchName ?? null,
            threadId: task?.codexThreadId ?? null,
          },
          requestHash,
        };
        this.atomicPersistence.persistCreate({
          binding: atomicBinding,
          key,
          kind: "create",
          receipt: { requestHash, response },
        });
      };
      let created;
      try {
        created = await this.invokeCreate(createInput);
      } catch (error) {
        cleanupPreparedAttachments(attachments);
        throw error;
      }
      const timestamp = this.now();
      const binding = atomicBinding ?? {
          qaInstanceId: input.qaInstanceId,
          handoffId: input.handoffId,
          attemptId: input.attemptId,
          defectId: input.defect.id,
          defectRevision: input.defect.revision,
          projectKey: input.defect.projectKey,
          projectId: createInput.projectId,
          taskId: created.taskId,
          initialTurnId: created.initialTurnId,
          requestHash,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      const save = async () => this.putBinding(binding);
      try {
        if (typeof this.transaction === "function") await this.transaction(save);
        else await save();
      } catch (error) {
        cleanupPreparedAttachments(attachments);
        throw error;
      }
      this.scheduler?.notifyQueueChanged?.();
      return {
        relayInstanceId: this.relayInstanceId,
        handoffId: input.handoffId,
        attemptId: input.attemptId,
        taskId: created.taskId,
        turnId: created.initialTurnId,
        initialTurnId: created.initialTurnId,
        status: created.status,
        branchName: created.task?.branchName ?? null,
        threadId: created.task?.codexThreadId ?? null,
        workspace: {
          projectId: createInput.projectId,
          branchName: created.task?.branchName ?? null,
          threadId: created.task?.codexThreadId ?? null,
        },
        requestHash,
      };
    });
  }

  async continueHandoff(handoffId, first, second = {}) {
    let actualHandoffId = handoffId;
    let firstArgument = first;
    let secondArgument = second;
    if (isObject(handoffId) && (Object.hasOwn(handoffId, "body") || Object.hasOwn(handoffId, "headers"))) {
      const request = handoffId;
      actualHandoffId = request.handoffId ?? request.params?.handoffId;
      firstArgument = request;
      secondArgument = first ?? {};
    }
    const envelope = requestEnvelope(firstArgument, secondArgument);
    const input = parseContinueBody(envelope.body, actualHandoffId, {
      maxAttachmentBytes: this.maxAttachmentBytes,
    });
    const principal = this.authenticate({ ...envelope.context, headers: envelope.headers }, QA_HUB_M2M_SCOPES.continue, input.qaInstanceId);
    const key = idempotencyKey(envelope.headers, envelope.idempotencyKey);
    const expectedKey = `qa:${input.qaInstanceId}:action:${input.actionId}`;
    if (key !== expectedKey) fail(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key does not match the action");
    const requestHash = canonicalPayloadHash({
      qaInstanceId: input.qaInstanceId,
      actionId: input.actionId,
      attemptId: input.attemptId,
      prompt: input.prompt,
      selectedAttachments: input.selectedAttachments,
    });
    const binding = await this.getBinding(input.qaInstanceId, input.handoffId);
    if (!binding) fail(404, "HANDOFF_NOT_FOUND", "handoff was not found");
    if (String(binding.attemptId) !== input.attemptId) fail(403, "FORBIDDEN", "attempt is not bound to this handoff");
    const project = await this.resolveProject(binding.projectKey);
    return this.executeIdempotent("continue", key, requestHash, async () => {
      const attachments = await this.fetchAttachments(input, binding.projectKey);
      const appendInput = {
        message: input.prompt,
        userName: principal.name || "QA Hub",
        idempotencyKey: key,
        preparedAttachments: attachments,
        projectId: String(project.id ?? project.projectId ?? binding.projectKey),
        qa: {
          qaInstanceId: input.qaInstanceId,
          handoffId: input.handoffId,
          actionId: input.actionId,
          attemptId: input.attemptId,
        },
      };
      let atomicBinding = null;
      appendInput.onCreatedInTransaction = ({ task, turn }) => {
        if (typeof this.atomicPersistence?.persistContinue !== "function") return;
        const appendedInTransaction = normalizeAppendResult({ turn });
        atomicBinding = { ...binding, updatedAt: this.now() };
        const response = {
          relayInstanceId: this.relayInstanceId,
          handoffId: input.handoffId,
          actionId: input.actionId,
          attemptId: input.attemptId,
          taskId: String(binding.taskId),
          turnId: appendedInTransaction.turnId,
          status: appendedInTransaction.status,
          branchName: task?.branchName ?? null,
          threadId: task?.codexThreadId ?? null,
          workspace: {
            projectId: binding.projectId,
            branchName: task?.branchName ?? null,
            threadId: task?.codexThreadId ?? null,
          },
          requestHash,
        };
        this.atomicPersistence.persistContinue({
          binding: atomicBinding,
          key,
          kind: "continue",
          receipt: { requestHash, response },
        });
      };
      let appended;
      try {
        appended = await this.invokeAppend(String(binding.taskId), appendInput);
      } catch (error) {
        cleanupPreparedAttachments(attachments);
        throw error;
      }
      this.scheduler?.notifyQueueChanged?.();
      const updated = atomicBinding ?? { ...binding, updatedAt: this.now() };
      try {
        await this.putBinding(updated);
      } catch (error) {
        cleanupPreparedAttachments(attachments);
        throw error;
      }
      const continuedTask =
        typeof this.store?.getTask === "function"
          ? this.store.getTask(String(binding.taskId))
          : null;
      return {
        relayInstanceId: this.relayInstanceId,
        handoffId: input.handoffId,
        actionId: input.actionId,
        attemptId: input.attemptId,
        taskId: String(binding.taskId),
        turnId: appended.turnId,
        status: appended.status,
        branchName: continuedTask?.branchName ?? null,
        threadId: continuedTask?.codexThreadId ?? null,
        workspace: {
          projectId: binding.projectId,
          branchName: continuedTask?.branchName ?? null,
          threadId: continuedTask?.codexThreadId ?? null,
        },
        requestHash,
      };
    });
  }

  async queryHandoff(handoffId, first, second = {}) {
    let actualHandoffId = handoffId;
    let firstArgument = first;
    let secondArgument = second;
    if (isObject(handoffId) && (Object.hasOwn(handoffId, "headers") || Object.hasOwn(handoffId, "query") || Object.hasOwn(handoffId, "params"))) {
      const request = handoffId;
      actualHandoffId = request.handoffId ?? request.params?.handoffId;
      firstArgument = request;
      secondArgument = first ?? {};
    }
    const envelope = requestEnvelope(firstArgument, secondArgument);
    const query = isObject(envelope.body) ? envelope.body : {};
    const qaInstanceId =
      query.qaInstanceId ??
      envelope.context?.qaInstanceId ??
      envelope.context?.query?.qaInstanceId ??
      new URL(envelope.context?.url ?? "http://127.0.0.1/").searchParams.get("qaInstanceId");
    const parsedQaInstanceId = stringValue(qaInstanceId, "qaInstanceId", { max: 64, pattern: QA_INSTANCE_ID });
    const parsedHandoffId = stringValue(actualHandoffId, "handoffId", { max: 200, pattern: SAFE_ID });
    this.authenticate({ ...envelope.context, headers: envelope.headers }, QA_HUB_M2M_SCOPES.read, parsedQaInstanceId);
    const binding = await this.getBinding(parsedQaInstanceId, parsedHandoffId);
    if (!binding) fail(404, "HANDOFF_NOT_FOUND", "handoff was not found");
    await this.resolveProject(binding.projectKey);
    const result = typeof this.queryAdapter === "function"
      ? await this.queryAdapter({ binding: clone(binding), taskId: String(binding.taskId), initialTurnId: String(binding.initialTurnId) })
      : defaultQueryResult(this.store, binding);
    const safeResult = redactUnsafe(result) ?? {};
    const task = isObject(safeResult.task) ? safeResult.task : null;
    const turns = Array.isArray(safeResult.turns) ? safeResult.turns : [];
    const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
    return {
      relayInstanceId: this.relayInstanceId,
      ...publicBinding(binding),
      status: safeResult.status ?? latestTurn?.status ?? task?.status ?? "unknown",
      branchName: task?.branchName ?? null,
      threadId: task?.codexThreadId ?? null,
      workspace: {
        projectId: binding.projectId,
        branchName: task?.branchName ?? null,
        threadId: task?.codexThreadId ?? null,
      },
      task: task ? clone(task) : null,
      latestTurn: latestTurn ? clone(latestTurn) : null,
      turns: clone(turns),
      latestDeliveryEvidence: clone(safeResult.latestDeliveryEvidence ?? safeResult.deliveryEvidence ?? null),
      build: clone(safeResult.build ?? safeResult.buildStatus ?? null),
      lastEvent: clone(safeResult.lastEvent ?? (Array.isArray(safeResult.events) ? safeResult.events.at(-1) : null)),
      webhookOutbox: clone(safeResult.webhookOutbox ?? safeResult.outbox ?? null),
    };
  }

  async create(first, second = {}) {
    return this.createHandoff(first, second);
  }

  async append(first, second = {}, third = {}) {
    if (typeof first === "string") return this.continueHandoff(first, second, third);
    return this.continueHandoff(first?.handoffId ?? first?.params?.handoffId, first, second);
  }

  async continue(first, second = {}, third = {}) {
    return this.append(first, second, third);
  }

  async queryHandoffById(first, second = {}, third = {}) {
    if (typeof first === "string") return this.queryHandoff(first, second, third);
    return this.queryHandoff(first?.handoffId ?? first?.params?.handoffId, first, second);
  }

  async query(first, second = {}, third = {}) {
    return this.queryHandoffById(first, second, third);
  }

  async handleCreate(request) {
    try {
      return {
        statusCode: 202,
        body: await this.createHandoff(request),
      };
    } catch (error) {
      return this.errorResponse(error);
    }
  }

  async handleContinue(first, second = {}, third = {}) {
    try {
      return {
        statusCode: 202,
        body:
          typeof first === "string"
            ? await this.continueHandoff(first, second, third)
            : await this.continueHandoff(first, second, third),
      };
    } catch (error) {
      return this.errorResponse(error);
    }
  }

  async handleRead(first, second = {}, third = {}) {
    try {
      return {
        statusCode: 200,
        body: await this.queryHandoffById(first, second, third),
      };
    } catch (error) {
      return this.errorResponse(error);
    }
  }

  errorResponse(error) {
    if (error instanceof QaHubM2MError) {
      return { statusCode: error.status, body: { code: error.code, message: error.message } };
    }
    return { statusCode: 500, body: { code: "INTEGRATION_INTERNAL_ERROR", message: "integration request failed" } };
  }

  async handle(request) {
    const method = String(request?.method ?? "GET").toUpperCase();
    const rawUrl = request?.url ?? request?.path ?? "/";
    const parsed = new URL(rawUrl, "http://127.0.0.1");
    const pathname = parsed.pathname.replace(/\/$/u, "") || "/";
    const handoffMatch = pathname.match(/^\/api\/integrations\/qa\/v1\/handoffs\/([^/]+)$/u);
    const turnMatch = pathname.match(/^\/api\/integrations\/qa\/v1\/handoffs\/([^/]+)\/turns$/u);
    try {
      if (method === "POST" && pathname === QA_HUB_HANDOFFS_PATH) {
        const body = await this.createHandoff({
          ...request,
          body: request.body,
          headers: request.headers,
          remoteAddress: remoteAddressOf(request),
        });
        return { status: 202, statusCode: 202, body, headers: { "cache-control": "no-store" } };
      }
      if (method === "POST" && turnMatch) {
        const body = await this.continueHandoff(decodeURIComponent(turnMatch[1]), {
          ...request,
          body: request.body,
          headers: request.headers,
          remoteAddress: remoteAddressOf(request),
        });
        return { status: 202, statusCode: 202, body, headers: { "cache-control": "no-store" } };
      }
      if (method === "GET" && handoffMatch) {
        const body = await this.queryHandoff(decodeURIComponent(handoffMatch[1]), {
          ...request,
          body: request.body,
          headers: request.headers,
          remoteAddress: remoteAddressOf(request),
          url: parsed.toString(),
        });
        return { status: 200, statusCode: 200, body, headers: { "cache-control": "no-store" } };
      }
      return {
        status: 404,
        statusCode: 404,
        body: { code: "NOT_FOUND", message: "integration route not found" },
        headers: { "cache-control": "no-store" },
      };
    } catch (error) {
      if (error instanceof QaHubM2MError) {
        return {
          status: error.status,
          statusCode: error.status,
          body: { code: error.code, message: error.message },
          headers: { "cache-control": "no-store" },
        };
      }
      return {
        status: 500,
        statusCode: 500,
        body: { code: "INTEGRATION_INTERNAL_ERROR", message: "integration request failed" },
        headers: { "cache-control": "no-store" },
      };
    }
  }
}

export function createQaHubM2MService(options = {}) {
  return new QaHubM2MService(options);
}

export const createQaHubM2M = createQaHubM2MService;
export class QaHubM2mService extends QaHubM2MService {}
