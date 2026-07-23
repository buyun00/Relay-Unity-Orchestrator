import crypto from "node:crypto";
import path from "node:path";

export function now() {
  return new Date().toISOString();
}

export function id(prefix = "") {
  return `${prefix}${crypto.randomUUID()}`;
}

export function shortSha(seed = crypto.randomUUID()) {
  return crypto.createHash("sha1").update(seed).digest("hex");
}

export function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function stringifyJson(value) {
  return value == null ? null : JSON.stringify(value);
}

export function asBoolean(value) {
  return value === true || value === 1 || value === "1";
}

export function integer(
  value,
  fallback = 0,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function requiredString(value, field, { max = 10_000 } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "VALIDATION_ERROR", `${field} is required`);
  }
  const result = value.trim();
  if (result.length > max) {
    throw new HttpError(400, "VALIDATION_ERROR", `${field} is too long`);
  }
  return result;
}

export function optionalString(value, field, { max = 10_000 } = {}) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "VALIDATION_ERROR", `${field} must be a string`);
  }
  const result = value.trim();
  if (result.length > max) {
    throw new HttpError(400, "VALIDATION_ERROR", `${field} is too long`);
  }
  return result || null;
}

export function gitRef(value, field = "branch") {
  const ref = requiredString(value, field, { max: 240 });
  if (
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("//") ||
    /[\x00-\x20\x7f~^:?*\[\\]/u.test(ref)
  ) {
    throw new HttpError(
      400,
      "INVALID_GIT_REF",
      `${field} is not a safe Git branch name`,
    );
  }
  return ref;
}

export function slug(value, fallback = "task") {
  const normalized = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    // Keep generated branch refs ASCII. Windows PowerShell 5.1 and Git can
    // otherwise disagree about native stdout encoding across PS Direct.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return normalized || fallback;
}

export function safeFilename(value) {
  let decoded = String(value || "attachment.bin");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep malformed percent-encoding as literal text; sanitization still applies.
  }
  const base = path.basename(decoded);
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return (cleaned || "attachment.bin").slice(0, 180);
}

export function resolveWorkerTemplate(value, worker) {
  if (!value) return value;
  const replacements = {
    internalIp: worker?.internalIp,
    corporateIp: worker?.corporateIp,
    workerName: worker?.name,
    vmName: worker?.vmName,
  };
  return String(value).replace(
    /\{(internalIp|corporateIp|workerName|vmName)\}/g,
    (_, key) => {
      const replacement = replacements[key];
      if (!replacement) {
        throw Object.assign(
          new Error(
            `Cannot resolve {${key}} because the worker field is empty`,
          ),
          {
            code: "WORKER_TEMPLATE_VALUE_MISSING",
          },
        );
      }
      return replacement;
    },
  );
}

export function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason || new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorPayload(error) {
  return {
    ok: false,
    error: {
      code: error?.code || "INTERNAL_ERROR",
      message: error?.message || "Unexpected server error",
      ...(error?.details === undefined ? {} : { details: error.details }),
    },
  };
}
