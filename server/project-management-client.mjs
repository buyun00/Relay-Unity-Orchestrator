import crypto from "node:crypto";
import path from "node:path";

import { HttpError, safeFilename } from "./util.mjs";
import { PROJECT_MANAGEMENT_SESSION_STATE_FORMAT } from "./project-management-session-store.mjs";

const LOGIN_STATUS = new Map([
  ["0", "pending"],
  ["1", "scanned"],
  ["2", "confirmed"],
  ["3", "expired"],
  ["4", "cancelled"],
]);

const EMPTY_DEFECT_CONTENT = "该缺陷暂未填写详细描述。";
const DEFECT_DETAIL_CONCURRENCY = 6;
const MAX_DEFECT_IMAGES = 8;
const MAX_IMAGE_REDIRECTS = 5;
const IMAGE_CONTENT_TYPES = new Map([
  ["image/avif", { extension: ".avif", extensions: new Set([".avif"]) }],
  ["image/bmp", { extension: ".bmp", extensions: new Set([".bmp"]) }],
  ["image/gif", { extension: ".gif", extensions: new Set([".gif"]) }],
  ["image/jpeg", { extension: ".jpg", extensions: new Set([".jpg", ".jpeg"]) }],
  ["image/png", { extension: ".png", extensions: new Set([".png"]) }],
  ["image/webp", { extension: ".webp", extensions: new Set([".webp"]) }],
]);
const TERMINAL_DEFECT_STATUS_KEYS = new Set([
  "ABORTED",
  "ARCHIVED",
  "CANCELED",
  "CANCELLED",
  "CLOSED",
  "COMPLETED",
  "DONE",
  "DUPLICATE",
  "FINISHED",
  "INVALID",
  "REJECTED",
  "RESOLVED",
  "TERMINATED",
  "TRANSFERRED",
  "VERIFIED",
  "VOID",
  "WONTFIX",
]);
const TERMINAL_DEFECT_STATUS_NAMES = new Set([
  "不予解决",
  "关闭",
  "取消",
  "完成",
  "已作废",
  "已关闭",
  "已取消",
  "已处理",
  "已完成",
  "已废弃",
  "已归档",
  "已拒绝",
  "已撤销",
  "已结束",
  "已解决",
  "已验证",
  "已终止",
  "拒绝",
  "结束",
  "终止",
  "转需求",
  "重复",
  "无需处理",
]);
const DEFECT_IMAGE_FIELDS = new Map([
  ["description", false],
  ["content", false],
  ["detail", false],
  ["details", false],
  ["attachment", false],
  ["attachments", false],
  ["attachmentlist", false],
  ["taskattachments", false],
  ["file", false],
  ["files", false],
  ["filelist", false],
  ["image", true],
  ["images", true],
  ["imagelist", true],
  ["imageurl", true],
  ["imageurls", true],
  ["screenshot", true],
  ["screenshots", true],
]);

function asId(value) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function sessionBinding(binding = null) {
  const browserId = asId(binding?.browserId);
  const relayUserName = String(binding?.relayUserName || "")
    .trim()
    .slice(0, 80);
  if (!browserId || !relayUserName) {
    return { key: null, relayUserName: null };
  }
  const key = crypto
    .createHash("sha256")
    .update(`${browserId}\u001f${relayUserName}`)
    .digest("hex");
  return { key, relayUserName };
}

function nestedValue(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") return null;
    current = current[key];
  }
  return current;
}

function firstValue(value, paths) {
  for (const path of paths) {
    const result = Array.isArray(path)
      ? nestedValue(value, path)
      : value?.[path];
    if (result != null && result !== "") return result;
  }
  return null;
}

function richText(value, depth = 0) {
  if (depth > 8 || value == null) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => richText(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  const preferred = [
    value.content,
    value.children,
    value.blocks,
    value.value,
  ].filter(Boolean);
  if (preferred.length) return richText(preferred, depth + 1);
  return "";
}

function plainText(value) {
  return richText(value)
    .replace(/<\s*br\s*\/?\s*>/giu, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/\r/gu, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function displayName(value) {
  if (!value) return null;
  if (typeof value === "string") return value.trim() || null;
  return (
    firstValue(value, ["nickname", "name", "username", "display_name"]) || null
  );
}

function normalizeUrl(value, baseUrl) {
  if (typeof value !== "string" || !value.trim()) return null;
  const decoded = value.replace(/&amp;/giu, "&").trim();
  try {
    const url = baseUrl ? new URL(decoded, baseUrl) : new URL(decoded);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function imageLikeUrl(value, baseUrl) {
  const normalized = normalizeUrl(value, baseUrl);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (/\.(?:avif|bmp|gif|jpe?g|png|webp)(?:$|[?#])/iu.test(url.href)) {
      return normalized;
    }
    if (/image|avatar|cover|attachment|upload|asset/iu.test(url.pathname)) {
      return normalized;
    }
  } catch {
    return null;
  }
  return null;
}

function imageIdentity(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

function addImage(output, value, baseUrl, assumeImage = false) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate || /[<>"'\s]/u.test(candidate)) return;
  const normalized = assumeImage
    ? normalizeUrl(candidate, baseUrl)
    : imageLikeUrl(candidate, baseUrl);
  if (!normalized) return;
  const identity = imageIdentity(normalized);
  if (!output.has(identity)) output.set(identity, normalized);
}

function normalizedFieldName(value) {
  return String(value || "")
    .replace(/[^a-z0-9]/giu, "")
    .toLowerCase();
}

function defectImageFieldMode(key) {
  const normalized = normalizedFieldName(key);
  if (
    /avatar|cover|icon|logo|portrait|profile|assignee|creator|owner|member/iu.test(
      normalized,
    )
  ) {
    return null;
  }
  if (DEFECT_IMAGE_FIELDS.has(normalized)) {
    return DEFECT_IMAGE_FIELDS.get(normalized);
  }
  if (/description|content|detail|attachment|file/iu.test(normalized)) {
    return false;
  }
  if (/image|img|screenshot|photo|picture/iu.test(normalized)) return true;
  return null;
}

function isPrimaryDefectImageField(key) {
  const normalized = normalizedFieldName(key);
  return /description|content|detail|attachment|file|screenshot|photo|picture|images|imgs/iu.test(
    normalized,
  );
}

function collectTrustedImages(
  value,
  baseUrl,
  output,
  { assumeImage = false, depth = 0 } = {},
) {
  if (depth > 7 || value == null || output.size >= 8) return;
  if (typeof value === "string") {
    const htmlMatches = value.matchAll(
      /<img[^>]+src\s*=\s*["']([^"']+)["']/giu,
    );
    for (const match of htmlMatches) {
      addImage(output, match[1], baseUrl, true);
      if (output.size >= 8) return;
    }
    if (assumeImage) addImage(output, value, baseUrl, true);
    const urlMatches = value.matchAll(/https?:\/\/[^\s"'<>]+/giu);
    for (const match of urlMatches) {
      addImage(output, match[0], baseUrl, assumeImage);
      if (output.size >= 8) return;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTrustedImages(item, baseUrl, output, {
        assumeImage,
        depth: depth + 1,
      });
      if (output.size >= 8) break;
    }
    return;
  }
  if (typeof value !== "object") return;
  const objectAssumesImage =
    assumeImage ||
    String(
      firstValue(value, [
        "mime_type",
        "mimeType",
        "content_type",
        "contentType",
      ]) || "",
    )
      .trim()
      .toLowerCase()
      .startsWith("image/") ||
    Boolean(
      imageLikeUrl(
        String(firstValue(value, ["filename", "file_name", "name"]) || ""),
        baseUrl,
      ),
    );
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = normalizedFieldName(key);
    if (/avatar|cover|icon|logo|portrait|profile/iu.test(normalizedKey))
      continue;
    const childAssumesImage =
      /^(?:image|imageurl|src|thumbnail|thumbnailurl|thumb|preview|previewurl|screenshot)$/u.test(
        normalizedKey,
      ) ||
      (objectAssumesImage &&
        /^(?:url|uri|path|downloadurl|downloaduri)$/u.test(normalizedKey));
    collectTrustedImages(item, baseUrl, output, {
      assumeImage: childAssumesImage,
      depth: depth + 1,
    });
    if (output.size >= 8) break;
  }
}

function collectDefectImages(value, baseUrl) {
  const primary = new Map();
  const fallback = new Map();
  for (const [key, item] of Object.entries(value || {})) {
    const assumeImage = defectImageFieldMode(key);
    if (assumeImage == null) continue;
    const output = isPrimaryDefectImageField(key) ? primary : fallback;
    collectTrustedImages(item, baseUrl, output, { assumeImage });
    if (primary.size >= 8) break;
  }
  return [...(primary.size ? primary : fallback).values()];
}

function mergeImageLists(...lists) {
  const output = new Map();
  for (const list of lists) {
    for (const value of list || []) {
      const normalized = normalizeUrl(value, null);
      if (!normalized) continue;
      const identity = imageIdentity(normalized);
      if (!output.has(identity)) output.set(identity, normalized);
      if (output.size >= 8) return [...output.values()];
    }
  }
  return [...output.values()];
}

function listFromPayload(payload) {
  const data = payload?.data ?? payload;
  if (Array.isArray(data)) return data;
  for (const candidate of [
    data?.list,
    data?.items,
    data?.records,
    data?.data,
  ]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function totalFromPayload(payload, fallback) {
  const data = payload?.data ?? payload;
  const value =
    payload?.meta?.total ??
    data?.meta?.total ??
    data?.total ??
    payload?.total ??
    fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dataFromPayload(payload) {
  const data = payload?.data ?? payload;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data.item ?? data.task ?? data;
  }
  return data;
}

function statusIdentity(value) {
  if (value == null) return { key: "", name: "" };
  if (typeof value === "string" || typeof value === "number") {
    const text = plainText(value);
    return { key: text.toUpperCase(), name: text };
  }
  return {
    key: String(
      firstValue(value, ["status_key", "key", "code", "status"]) || "",
    ).toUpperCase(),
    name: plainText(firstValue(value, ["name", "status_name", "label"])),
  };
}

function canonicalStatusKey(value) {
  return String(value || "")
    .trim()
    .replace(/[\s_-]+/gu, "")
    .toUpperCase();
}

export function isActionableProjectManagementDefect(defect) {
  const status = statusIdentity(
    defect?.statusKey
      ? { status_key: defect.statusKey, name: defect.status }
      : defect?.status,
  );
  const key = canonicalStatusKey(status.key);
  const name = String(status.name || defect?.status || "")
    .trim()
    .replace(/\s+/gu, "");
  if (!key && !name) return true;
  return (
    !TERMINAL_DEFECT_STATUS_KEYS.has(key) &&
    !TERMINAL_DEFECT_STATUS_NAMES.has(name)
  );
}

function resolvedStatus(value) {
  const status = statusIdentity(value);
  return (
    ["RESOLVED", "CLOSED", "VERIFIED"].includes(status.key) ||
    ["已解决", "已关闭", "已验证"].includes(status.name)
  );
}

function resolvingTransition(value) {
  if (!value || typeof value !== "object") return false;
  return resolvedStatus(value.to_status || value.toStatus || value.status);
}

function numericId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function versionRank(value) {
  const status = String(
    firstValue(value, ["status", "status_key", "state"]) || "",
  ).toLowerCase();
  if (["in_progress", "active", "current", "进行中"].includes(status)) return 0;
  if (["pending", "planned", "open", "未开始"].includes(status)) return 1;
  if (["completed", "closed", "archived", "已完成"].includes(status)) return 3;
  return 2;
}

function normalizeUser(value) {
  if (!value || typeof value !== "object") return null;
  const id = asId(firstValue(value, ["ID", "id", "user_id", "UserID"]));
  if (!id) return null;
  return {
    id,
    name:
      displayName(value) ||
      String(firstValue(value, ["phone", "email"]) || `用户 ${id}`),
    avatar: normalizeUrl(firstValue(value, ["avatar", "avatar_url"]), null),
  };
}

function normalizeProject(value) {
  if (!value || typeof value !== "object") return null;
  const id = asId(firstValue(value, ["ID", "id", "project_id"]));
  if (!id) return null;
  return {
    id,
    name: String(
      firstValue(value, ["name", "project_name", "title"]) || `项目 ${id}`,
    ),
  };
}

function normalizeDefect(value, baseUrl) {
  if (!value || typeof value !== "object") return null;
  const id = asId(
    firstValue(value, ["ID", "id", "task_id", "TaskID", "bug_id"]),
  );
  if (!id) return null;
  const title = plainText(
    firstValue(value, ["title", "name", "subject", "summary"]),
  );
  const contentParts = [
    firstValue(value, ["description", "content", "detail", "details"]),
    firstValue(value, [
      "reproduce_steps",
      "reproduction_steps",
      "steps",
      "actual_result",
    ]),
    firstValue(value, ["expected_result", "acceptance_criteria"]),
  ]
    .map(plainText)
    .filter(Boolean);
  const content = [...new Set(contentParts)].join("\n\n").slice(0, 100_000);
  const code = asId(
    firstValue(value, [
      "bug_no",
      "task_no",
      "serial_no",
      "code",
      "number",
      "key",
    ]),
  );
  const status = firstValue(value, [
    "bug_status_name",
    "status_name",
    ["bug_status", "name"],
    ["status", "name"],
    "status",
  ]);
  const statusKey = firstValue(value, [
    "bug_status_key",
    "status_key",
    ["bug_status", "status_key"],
    ["status", "status_key"],
    ["bug_status", "key"],
    ["status", "key"],
    ["bug_status", "code"],
    ["status", "code"],
  ]);
  const priority = firstValue(value, [
    "priority_name",
    ["priority", "name"],
    "priority",
  ]);
  const severity = firstValue(value, [
    "severity_name",
    ["severity", "name"],
    "severity",
  ]);
  const assignee = firstValue(value, [
    "assignee_name",
    ["assignee", "nickname"],
    ["assignee", "name"],
    ["assignee_user", "nickname"],
    ["assignee_user", "name"],
  ]);
  const updatedAt = firstValue(value, [
    "updated_at",
    "update_time",
    "UpdatedAt",
    "modified_at",
  ]);
  return {
    id,
    code,
    title: title || `未命名缺陷 ${code || id}`,
    content: content || EMPTY_DEFECT_CONTENT,
    status: status == null ? null : plainText(status),
    statusKey:
      statusKey == null ? null : String(statusKey).trim().toUpperCase() || null,
    priority: priority == null ? null : plainText(priority),
    severity: severity == null ? null : plainText(severity),
    assignee: assignee == null ? null : plainText(assignee),
    updatedAt: updatedAt == null ? null : String(updatedAt),
    images: collectDefectImages(value, baseUrl),
    url: new URL(`/tasks/${encodeURIComponent(id)}`, baseUrl).toString(),
  };
}

function mergeDefectSummary(summary, detail) {
  const detailHasContent = detail.content !== EMPTY_DEFECT_CONTENT;
  return {
    ...summary,
    ...detail,
    id: summary.id,
    code: detail.code || summary.code,
    title: detail.title || summary.title,
    content: detailHasContent ? detail.content : summary.content,
    status: detail.status || summary.status,
    statusKey: detail.statusKey || summary.statusKey,
    priority: detail.priority || summary.priority,
    severity: detail.severity || summary.severity,
    assignee: detail.assignee || summary.assignee,
    updatedAt: detail.updatedAt || summary.updatedAt,
    images: detail.images.length
      ? mergeImageLists(detail.images)
      : mergeImageLists(summary.images),
    url: detail.url || summary.url,
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function normalizedLoginStatus(value) {
  const key = String(value ?? "").toLowerCase();
  return LOGIN_STATUS.get(key) ||
    ["pending", "scanned", "confirmed", "expired", "cancelled"].includes(key)
    ? LOGIN_STATUS.get(key) || key
    : "error";
}

function trimMessage(value, max = 600) {
  const message = String(value || "").trim();
  return message ? message.slice(0, max) : "项目管理系统请求失败";
}

function normalizedImageContentType(value) {
  const contentType = String(value || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType === "image/jpg" || contentType === "image/pjpeg") {
    return "image/jpeg";
  }
  if (contentType === "image/x-ms-bmp") return "image/bmp";
  return IMAGE_CONTENT_TYPES.has(contentType) ? contentType : null;
}

function sniffImageContentType(buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  const prefix = buffer.subarray(0, 12).toString("ascii");
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  if (buffer.length >= 2 && prefix.startsWith("BM")) return "image/bmp";
  if (
    buffer.length >= 16 &&
    buffer.subarray(4, 8).toString("ascii") === "ftyp" &&
    /avif|avis/u.test(buffer.subarray(8, 32).toString("ascii"))
  ) {
    return "image/avif";
  }
  return null;
}

function dispositionFilename(value) {
  const header = String(value || "");
  const encoded = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/iu)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim().replace(/^"|"$/gu, ""));
    } catch {
      // Fall back to the plain filename or URL path below.
    }
  }
  const quoted = header.match(/filename\s*=\s*"((?:\\.|[^"])*)"/iu)?.[1];
  if (quoted) return quoted.replace(/\\([\\"])/gu, "$1");
  return header.match(/filename\s*=\s*([^;]+)/iu)?.[1]?.trim() || null;
}

function imageFilename(response, url, contentType, index) {
  const fromHeader = dispositionFilename(
    response.headers.get("content-disposition"),
  );
  let candidate =
    fromHeader || path.basename(url.pathname) || `image-${index + 1}`;
  candidate = safeFilename(candidate);
  const imageType = IMAGE_CONTENT_TYPES.get(contentType);
  const extension = path.extname(candidate).toLowerCase();
  if (imageType.extensions.has(extension)) return candidate;
  const stem = extension ? candidate.slice(0, -extension.length) : candidate;
  return safeFilename(`${stem || `image-${index + 1}`}${imageType.extension}`);
}

async function readImageBody(response, limitBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new HttpError(
      413,
      "PROJECT_MANAGEMENT_IMAGE_TOO_LARGE",
      `轻语图片超过单张 ${limitBytes} 字节的限制`,
    );
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > limitBytes) {
        await reader.cancel();
        throw new HttpError(
          413,
          "PROJECT_MANAGEMENT_IMAGE_TOO_LARGE",
          `轻语图片超过单张 ${limitBytes} 字节的限制`,
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export function projectManagementTaskKey({
  relayProjectId,
  externalProjectId,
  defectId,
}) {
  const source = [relayProjectId, externalProjectId, defectId]
    .map((item) => String(item || "").trim())
    .join("\u001f");
  const digest = crypto.createHash("sha256").update(source).digest("hex");
  return `project-management:${digest}`;
}

export function projectManagementTaskTitle(defect) {
  const prefix = defect.code ? `[${defect.code}] ` : "";
  return `${prefix}${defect.title || `缺陷 ${defect.id}`}`.trim().slice(0, 200);
}

export function projectManagementTaskPrompt(defect, extraPrompt = "") {
  const metadata = [
    defect.code && `缺陷编号：${defect.code}`,
    defect.status && `状态：${defect.status}`,
    defect.priority && `优先级：${defect.priority}`,
    defect.severity && `严重程度：${defect.severity}`,
    defect.assignee && `负责人：${defect.assignee}`,
    defect.updatedAt && `最后更新：${defect.updatedAt}`,
  ].filter(Boolean);
  const imageLines = defect.images?.length
    ? `\n\n缺陷图片：已下载并作为本轮图片附件提供（${defect.images.length} 张）`
    : "";
  const supplement = String(extraPrompt || "").trim();
  return [
    "请处理以下从项目管理系统导入的缺陷。先理解缺陷描述和现有项目，再完成修复并按任务要求验证。",
    `标题：${defect.title}`,
    ...metadata,
    `来源：${defect.url}`,
    `\n缺陷内容：\n${defect.content || "该缺陷暂未填写详细描述。"}${imageLines}`,
    supplement ? `\n用户补充提示词：\n${supplement}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 100_000);
}

export class ProjectManagementClient {
  constructor({
    baseUrl = "https://50qweb.jiaxianghudong.com",
    timeoutMs = 10_000,
    sessionTtlMs = 12 * 60 * 60 * 1000,
    fetchImpl = fetch,
    sessionStore = null,
    initialSessionState = null,
    onSessionPersistenceError = (error) =>
      console.warn(
        `Project-management session persistence failed: ${error.message}`,
      ),
  } = {}) {
    this.baseUrl = new URL(baseUrl).origin;
    this.timeoutMs = timeoutMs;
    this.sessionTtlMs = sessionTtlMs;
    this.fetchImpl = fetchImpl;
    this.sessionStore = sessionStore;
    this.onSessionPersistenceError = onSessionPersistenceError;
    this.sessions = new Map();
    this.sessionIdsByBinding = new Map();
    this.restoreSessions(initialSessionState);
  }

  restoreSessions(state) {
    if (
      !state ||
      state.format !== PROJECT_MANAGEMENT_SESSION_STATE_FORMAT ||
      !Array.isArray(state.sessions)
    ) {
      return;
    }
    for (const value of state.sessions) {
      const id = asId(value?.id);
      const bindingKey = String(value?.bindingKey || "").toLowerCase();
      const relayUserName = String(value?.relayUserName || "")
        .trim()
        .slice(0, 80);
      const token = String(value?.token || "").trim();
      const userId = asId(value?.user?.id);
      const userName = String(value?.user?.name || "")
        .trim()
        .slice(0, 200);
      if (
        !id ||
        !/^[0-9a-f-]{36}$/u.test(id) ||
        !/^[0-9a-f]{64}$/u.test(bindingKey) ||
        !relayUserName ||
        !token ||
        token.length > 100_000 ||
        !userId ||
        !userName
      ) {
        continue;
      }
      if (this.sessions.has(id)) continue;
      const createdAt = Number(value.createdAt);
      const lastUsedAt = Number(value.lastUsedAt);
      const previousId = this.sessionIdsByBinding.get(bindingKey);
      const previous = previousId ? this.sessions.get(previousId) : null;
      if (previous && previous.lastUsedAt >= lastUsedAt) continue;
      if (previousId) this.sessions.delete(previousId);
      this.sessions.set(id, {
        id,
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        lastUsedAt: Number.isFinite(lastUsedAt) ? lastUsedAt : Date.now(),
        bindingKey,
        relayUserName,
        token,
        user: {
          id: userId,
          name: userName,
          avatar: normalizeUrl(value.user?.avatar, null),
        },
        login: null,
        projectSelections: new Map(),
      });
      this.sessionIdsByBinding.set(bindingKey, id);
    }
  }

  persistentState() {
    return {
      format: PROJECT_MANAGEMENT_SESSION_STATE_FORMAT,
      savedAt: new Date().toISOString(),
      sessions: [...this.sessions.values()]
        .filter(
          (session) => session.bindingKey && session.token && session.user?.id,
        )
        .map((session) => ({
          id: session.id,
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
          bindingKey: session.bindingKey,
          relayUserName: session.relayUserName,
          token: session.token,
          user: session.user,
        })),
    };
  }

  async persistSessions() {
    if (!this.sessionStore) return;
    try {
      await this.sessionStore.save(this.persistentState());
    } catch (error) {
      this.onSessionPersistenceError?.(error);
    }
  }

  createSession(binding = null) {
    this.cleanupSessions();
    const id = crypto.randomUUID();
    const timestamp = Date.now();
    const resolvedBinding = sessionBinding(binding);
    this.sessions.set(id, {
      id,
      createdAt: timestamp,
      lastUsedAt: timestamp,
      bindingKey: resolvedBinding.key,
      relayUserName: resolvedBinding.relayUserName,
      token: null,
      user: null,
      login: null,
      projectSelections: new Map(),
    });
    if (resolvedBinding.key) {
      this.sessionIdsByBinding.set(resolvedBinding.key, id);
    }
    return id;
  }

  ensureSession(sessionId = null, binding = null) {
    this.cleanupSessions();
    const resolvedBinding = sessionBinding(binding);
    const existing = sessionId ? this.sessions.get(sessionId) : null;
    if (
      existing &&
      (!resolvedBinding.key || existing.bindingKey === resolvedBinding.key)
    ) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (resolvedBinding.key) {
      const boundSessionId = this.sessionIdsByBinding.get(resolvedBinding.key);
      const boundSession = boundSessionId
        ? this.sessions.get(boundSessionId)
        : null;
      if (boundSession) {
        boundSession.lastUsedAt = Date.now();
        return boundSession;
      }
      if (boundSessionId) {
        this.sessionIdsByBinding.delete(resolvedBinding.key);
      }
    }
    return this.sessions.get(this.createSession(binding));
  }

  requireSession(sessionId) {
    const session = sessionId ? this.sessions.get(sessionId) : null;
    if (!session) {
      throw new HttpError(
        401,
        "PROJECT_MANAGEMENT_SESSION_REQUIRED",
        "缺陷列表会话已失效，请重新打开创建任务弹窗",
      );
    }
    session.lastUsedAt = Date.now();
    return session;
  }

  cleanupSessions() {
    const cutoff = Date.now() - this.sessionTtlMs;
    for (const [id, session] of this.sessions) {
      if (session.token && session.user) continue;
      if (session.lastUsedAt >= cutoff) continue;
      this.sessions.delete(id);
      if (
        session.bindingKey &&
        this.sessionIdsByBinding.get(session.bindingKey) === id
      ) {
        this.sessionIdsByBinding.delete(session.bindingKey);
      }
    }
  }

  publicSession(sessionId) {
    const session = this.requireSession(sessionId);
    return {
      authenticated: Boolean(session.token && session.user),
      relayUserName: session.relayUserName,
      user: session.user,
      login: session.login
        ? {
            status: session.login.status,
            qrContent: session.login.qrContent,
            expiresAt: session.login.expiresAt,
          }
        : null,
    };
  }

  completionBinding(sessionId) {
    const session = this.requireSession(sessionId);
    if (!session.token || !session.user || !session.bindingKey) {
      throw new HttpError(
        401,
        "PROJECT_MANAGEMENT_AUTH_REQUIRED",
        "请先使用轻羽 APP 扫码登录",
      );
    }
    return {
      bindingKey: session.bindingKey,
      relayUserName: session.relayUserName,
      userId: String(session.user.id),
      userName: session.user.name,
    };
  }

  sessionByBindingKey(bindingKey, expectedUser = null) {
    const normalized = String(bindingKey || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(normalized)) {
      throw new HttpError(
        401,
        "PROJECT_MANAGEMENT_LINKED_SESSION_REQUIRED",
        "该任务绑定的轻语登录已失效，请使用发起任务时的 Relay 用户和浏览器重新扫码",
      );
    }
    const sessionId = this.sessionIdsByBinding.get(normalized);
    const session = sessionId ? this.sessions.get(sessionId) : null;
    if (!session?.token || !session?.user) {
      throw new HttpError(
        401,
        "PROJECT_MANAGEMENT_LINKED_SESSION_REQUIRED",
        "该任务绑定的轻语登录已失效，请使用发起任务时的 Relay 用户和浏览器重新扫码",
      );
    }
    const expectedUserId = asId(expectedUser?.id);
    const actualUserId = asId(session.user.id);
    if (expectedUserId && actualUserId !== expectedUserId) {
      const expectedUserName = String(expectedUser?.name || expectedUserId);
      const actualUserName = String(
        session.user.name || actualUserId || "未知账号",
      );
      throw new HttpError(
        409,
        "PROJECT_MANAGEMENT_ACCOUNT_MISMATCH",
        `该任务绑定的轻语账号是“${expectedUserName}”，当前登录的是“${actualUserName}”；请切换回原账号并重新扫码后再试`,
        {
          expectedUserId,
          expectedUserName,
          actualUserId,
          actualUserName,
        },
      );
    }
    session.lastUsedAt = Date.now();
    return session;
  }

  async request(
    pathname,
    { method = "GET", query = null, body = undefined, token = null } = {},
  ) {
    const url = new URL(`/api${pathname}`, this.baseUrl);
    for (const [key, value] of Object.entries(query || {})) {
      if (value != null && value !== "")
        url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Project management request timed out")),
      this.timeoutMs,
    );
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const message = trimMessage(
          payload?.message || payload?.error?.message || response.statusText,
        );
        throw new HttpError(
          response.status === 401 ? 401 : 502,
          response.status === 401
            ? "PROJECT_MANAGEMENT_AUTH_REQUIRED"
            : "PROJECT_MANAGEMENT_UPSTREAM_FAILED",
          response.status === 401 ? "登录已过期，请重新扫码" : message,
          { upstreamStatus: response.status },
        );
      }
      if (
        payload &&
        typeof payload === "object" &&
        payload.code != null &&
        Number(payload.code) !== 0
      ) {
        throw new HttpError(
          Number(payload.code) === 401 ? 401 : 502,
          Number(payload.code) === 401
            ? "PROJECT_MANAGEMENT_AUTH_REQUIRED"
            : "PROJECT_MANAGEMENT_UPSTREAM_REJECTED",
          Number(payload.code) === 401
            ? "登录已过期，请重新扫码"
            : trimMessage(payload.message),
          { upstreamCode: payload.code },
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (controller.signal.aborted) {
        throw new HttpError(
          504,
          "PROJECT_MANAGEMENT_TIMEOUT",
          "项目管理系统响应超时，请稍后重试",
        );
      }
      throw new HttpError(
        502,
        "PROJECT_MANAGEMENT_UNAVAILABLE",
        `无法连接项目管理系统：${trimMessage(error?.message, 240)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async clearAuthentication(session) {
    session.token = null;
    session.user = null;
    session.login = null;
    await this.persistSessions();
  }

  async authenticatedRequest(session, pathname, options = {}) {
    if (!session.token) {
      throw new HttpError(
        401,
        "PROJECT_MANAGEMENT_AUTH_REQUIRED",
        "请先使用轻羽 APP 扫码登录",
      );
    }
    try {
      return await this.request(pathname, { ...options, token: session.token });
    } catch (error) {
      if (error?.status === 401) await this.clearAuthentication(session);
      throw error;
    }
  }

  async startLogin(sessionId) {
    const session = this.requireSession(sessionId);
    const payload = await this.request("/auth/qr/home-generate", {
      method: "POST",
      body: { app_type: "project", secure: true },
    });
    const data = dataFromPayload(payload);
    const qrId = asId(data?.qr_id);
    const qrContent = String(data?.qr_content || "").trim();
    if (!qrId || !qrContent) {
      throw new HttpError(
        502,
        "PROJECT_MANAGEMENT_QR_INVALID",
        "项目管理系统没有返回有效二维码",
      );
    }
    session.token = null;
    session.user = null;
    session.login = {
      qrId,
      pollToken: asId(data?.poll_token),
      qrContent,
      status: "pending",
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };
    await this.persistSessions();
    return this.publicSession(sessionId);
  }

  async pollLogin(sessionId) {
    const session = this.requireSession(sessionId);
    if (!session.login) return this.publicSession(sessionId);
    const payload = await this.request("/auth/qr/home-status", {
      query: {
        qr_id: session.login.qrId,
        poll_token: session.login.pollToken,
      },
    });
    const data = dataFromPayload(payload);
    const status = normalizedLoginStatus(data?.status);
    session.login.status = status;
    if (status === "confirmed") {
      const ticket = String(data?.ticket || "").trim();
      const phone = String(data?.phone || "").trim();
      if (!ticket || !phone) {
        throw new HttpError(
          502,
          "PROJECT_MANAGEMENT_QR_CONFIRMATION_INVALID",
          "扫码确认信息不完整，请重新生成二维码",
        );
      }
      const exchange = await this.request("/auth/qr/exchange", {
        method: "POST",
        body: { ticket, phone },
      });
      const exchangeData = dataFromPayload(exchange);
      const token = String(exchangeData?.token || "").trim();
      const user = normalizeUser(exchangeData?.user);
      if (!token || !user) {
        throw new HttpError(
          502,
          "PROJECT_MANAGEMENT_LOGIN_INVALID",
          "扫码登录成功，但用户信息不完整",
        );
      }
      session.token = token;
      session.user = user;
      session.login = null;
      await this.persistSessions();
    }
    return this.publicSession(sessionId);
  }

  async logout(sessionId) {
    const session = this.requireSession(sessionId);
    await this.clearAuthentication(session);
    return this.publicSession(sessionId);
  }

  async currentUser(session) {
    if (session.user?.id) return session.user;
    const payload = await this.authenticatedRequest(session, "/users/me");
    const user = normalizeUser(dataFromPayload(payload));
    if (!user) {
      throw new HttpError(
        502,
        "PROJECT_MANAGEMENT_USER_INVALID",
        "无法识别项目管理系统当前用户",
      );
    }
    session.user = user;
    return user;
  }

  async listProjects(sessionId) {
    const session = this.requireSession(sessionId);
    const payload = await this.authenticatedRequest(session, "/projects", {
      query: { page: 1, page_size: 200 },
    });
    return listFromPayload(payload).map(normalizeProject).filter(Boolean);
  }

  rememberProject(sessionId, relayProjectId, externalProjectId) {
    const session = this.requireSession(sessionId);
    if (relayProjectId && externalProjectId) {
      session.projectSelections.set(
        String(relayProjectId),
        String(externalProjectId),
      );
    }
  }

  selectedProject(sessionId, relayProjectId) {
    return (
      this.requireSession(sessionId).projectSelections.get(
        String(relayProjectId || ""),
      ) || null
    );
  }

  defectUrl(defectId) {
    return new URL(
      `/tasks/${encodeURIComponent(defectId)}`,
      this.baseUrl,
    ).toString();
  }

  async listDefects(
    sessionId,
    { externalProjectId, page = 1, pageSize = 100, search = "" },
  ) {
    const session = this.requireSession(sessionId);
    const user = await this.currentUser(session);
    const payload = await this.authenticatedRequest(session, "/tasks", {
      query: {
        project_id: externalProjectId,
        type: "bug",
        assignee_id: user.id,
        page,
        page_size: pageSize,
        include_stats: 1,
        search: String(search || "").trim() || null,
      },
    });
    const defects = listFromPayload(payload)
      .map((item) => normalizeDefect(item, this.baseUrl))
      .filter(Boolean);
    const enrichedDefects = await mapWithConcurrency(
      defects,
      DEFECT_DETAIL_CONCURRENCY,
      async (summary) => {
        try {
          const detail = await this.getDefect(sessionId, summary.id);
          return mergeDefectSummary(summary, detail);
        } catch (error) {
          if (error?.status === 401) throw error;
          return summary;
        }
      },
    );
    return {
      defects: enrichedDefects,
      total: totalFromPayload(payload, defects.length),
      user,
    };
  }

  async getDefect(sessionId, defectId) {
    const session = this.requireSession(sessionId);
    const payload = await this.authenticatedRequest(
      session,
      `/tasks/${encodeURIComponent(defectId)}`,
    );
    const defect = normalizeDefect(dataFromPayload(payload), this.baseUrl);
    if (!defect) {
      throw new HttpError(
        502,
        "PROJECT_MANAGEMENT_DEFECT_INVALID",
        "项目管理系统返回的缺陷数据不完整",
      );
    }
    return defect;
  }

  async downloadDefectImage(session, imageUrl, index, limitBytes) {
    let url;
    try {
      url = new URL(imageUrl);
    } catch {
      throw new HttpError(
        502,
        "PROJECT_MANAGEMENT_IMAGE_URL_INVALID",
        `轻语第 ${index + 1} 张图片地址无效，任务尚未创建`,
      );
    }
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password) {
      throw new HttpError(
        502,
        "PROJECT_MANAGEMENT_IMAGE_URL_INVALID",
        `轻语第 ${index + 1} 张图片地址不受支持，任务尚未创建`,
      );
    }
    for (
      let redirectCount = 0;
      redirectCount <= MAX_IMAGE_REDIRECTS;
      redirectCount += 1
    ) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("Project management image timed out")),
        this.timeoutMs,
      );
      const sameOrigin = url.origin === this.baseUrl;
      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            Accept:
              "image/avif,image/webp,image/png,image/jpeg,image/gif,image/bmp,*/*;q=0.1",
            ...(sameOrigin ? { Authorization: `Bearer ${session.token}` } : {}),
          },
          redirect: "manual",
          signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location || redirectCount === MAX_IMAGE_REDIRECTS) {
            throw new HttpError(
              502,
              "PROJECT_MANAGEMENT_IMAGE_REDIRECT_INVALID",
              `轻语第 ${index + 1} 张图片重定向无效，任务尚未创建`,
            );
          }
          url = new URL(location, url);
          if (
            !/^https?:$/u.test(url.protocol) ||
            url.username ||
            url.password
          ) {
            throw new HttpError(
              502,
              "PROJECT_MANAGEMENT_IMAGE_URL_INVALID",
              `轻语第 ${index + 1} 张图片重定向到不受支持的地址，任务尚未创建`,
            );
          }
          continue;
        }
        if (!response.ok) {
          if (sameOrigin && response.status === 401) {
            await this.clearAuthentication(session);
            throw new HttpError(
              401,
              "PROJECT_MANAGEMENT_AUTH_REQUIRED",
              "登录已过期，请重新扫码",
            );
          }
          throw new HttpError(
            502,
            "PROJECT_MANAGEMENT_IMAGE_DOWNLOAD_FAILED",
            `轻语第 ${index + 1} 张图片下载失败（HTTP ${response.status}），任务尚未创建`,
          );
        }
        const buffer = await readImageBody(response, limitBytes);
        const declaredType = normalizedImageContentType(
          response.headers.get("content-type"),
        );
        const sniffedType = sniffImageContentType(buffer);
        const contentType = declaredType || sniffedType;
        if (
          !buffer.length ||
          !contentType ||
          !sniffedType ||
          (declaredType && sniffedType !== declaredType)
        ) {
          throw new HttpError(
            502,
            "PROJECT_MANAGEMENT_IMAGE_TYPE_INVALID",
            `轻语第 ${index + 1} 个图片链接没有返回有效图片，任务尚未创建`,
          );
        }
        return {
          filename: imageFilename(response, url, contentType, index),
          contentType,
          size: buffer.length,
          buffer,
        };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (controller.signal.aborted) {
          throw new HttpError(
            504,
            "PROJECT_MANAGEMENT_IMAGE_TIMEOUT",
            `轻语第 ${index + 1} 张图片下载超时，任务尚未创建`,
          );
        }
        throw new HttpError(
          502,
          "PROJECT_MANAGEMENT_IMAGE_DOWNLOAD_FAILED",
          `轻语第 ${index + 1} 张图片下载失败：${trimMessage(error?.message, 240)}`,
        );
      } finally {
        clearTimeout(timer);
      }
    }
    throw new HttpError(
      502,
      "PROJECT_MANAGEMENT_IMAGE_REDIRECT_INVALID",
      `轻语第 ${index + 1} 张图片重定向次数过多，任务尚未创建`,
    );
  }

  async downloadDefectImages(
    sessionId,
    defect,
    { limitBytes = 25 * 1024 * 1024 } = {},
  ) {
    const session = this.requireSession(sessionId);
    if (!session.token) {
      throw new HttpError(
        401,
        "PROJECT_MANAGEMENT_AUTH_REQUIRED",
        "请先使用轻羽 APP 扫码登录",
      );
    }
    const urls = [...new Set(defect?.images || [])].slice(0, MAX_DEFECT_IMAGES);
    const images = [];
    const totalLimitBytes = Math.min(
      limitBytes * MAX_DEFECT_IMAGES,
      100 * 1024 * 1024,
    );
    let totalBytes = 0;
    for (let index = 0; index < urls.length; index += 1) {
      const image = await this.downloadDefectImage(
        session,
        urls[index],
        index,
        limitBytes,
      );
      totalBytes += image.size;
      if (totalBytes > totalLimitBytes) {
        throw new HttpError(
          413,
          "PROJECT_MANAGEMENT_IMAGES_TOO_LARGE",
          `轻语缺陷图片总计超过 ${totalLimitBytes} 字节的限制，任务尚未创建`,
        );
      }
      images.push(image);
    }
    return images;
  }

  async resolveVersion(session, externalProjectId, task) {
    const existing = numericId(
      firstValue(task, [
        "resolve_version_id",
        "actual_version_id",
        "planned_version_id",
        "version_id",
        ["resolve_version", "ID"],
        ["actual_version", "ID"],
        ["planned_version", "ID"],
      ]),
    );
    if (existing) return existing;
    const payload = await this.authenticatedRequest(session, "/versions", {
      query: { project_id: externalProjectId },
    });
    const versions = listFromPayload(payload)
      .map((value, index) => ({
        id: numericId(firstValue(value, ["ID", "id", "version_id"])),
        rank: versionRank(value),
        index,
      }))
      .filter((value) => value.id)
      .sort(
        (left, right) => left.rank - right.rank || left.index - right.index,
      );
    if (!versions.length) {
      throw new HttpError(
        409,
        "PROJECT_MANAGEMENT_RESOLVE_VERSION_REQUIRED",
        "轻语工作流要求解决版本，但缺陷和项目都没有可用版本",
      );
    }
    return versions[0].id;
  }

  async resolveDefect(
    bindingKey,
    { defectId, externalProjectId, userId = null, userName = null },
  ) {
    const session = this.sessionByBindingKey(bindingKey, {
      id: userId,
      name: userName,
    });
    const encodedDefectId = encodeURIComponent(defectId);
    const taskPayload = await this.authenticatedRequest(
      session,
      `/tasks/${encodedDefectId}`,
    );
    const task = dataFromPayload(taskPayload);
    if (!task || typeof task !== "object") {
      throw new HttpError(
        502,
        "PROJECT_MANAGEMENT_DEFECT_INVALID",
        "轻语返回的缺陷详情不完整",
      );
    }
    const transitionsPayload = await this.authenticatedRequest(
      session,
      `/tasks/${encodedDefectId}/bug-transitions`,
    );
    const currentStatus =
      transitionsPayload?.current_status ||
      transitionsPayload?.data?.current_status ||
      task.bug_status ||
      task.status;
    if (resolvedStatus(currentStatus)) {
      const status = statusIdentity(currentStatus);
      return {
        defectId: String(defectId),
        status: status.name || status.key,
        alreadyResolved: true,
      };
    }
    const transitions = listFromPayload(transitionsPayload);
    const transition = transitions.find(resolvingTransition);
    if (!transition) {
      throw new HttpError(
        409,
        "PROJECT_MANAGEMENT_RESOLVE_TRANSITION_UNAVAILABLE",
        "轻语当前状态没有可用的“已解决”流转，或绑定账号无权执行",
      );
    }
    const transitionId = numericId(
      firstValue(transition, ["ID", "id", "transition_id"]),
    );
    const version = numericId(firstValue(task, ["version", "Version"]));
    if (!transitionId || !version) {
      throw new HttpError(
        409,
        "PROJECT_MANAGEMENT_TRANSITION_INVALID",
        "轻语缺陷缺少流转编号或并发版本号，已停止更新",
      );
    }
    const requiredFields = String(transition.required_fields || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const body = { transition_id: transitionId, version };
    for (const field of requiredFields) {
      if (field === "resolve_version_id") {
        body.resolve_version_id = await this.resolveVersion(
          session,
          externalProjectId,
          task,
        );
        continue;
      }
      const value = firstValue(task, [field]);
      if (value == null || value === "") {
        throw new HttpError(
          409,
          "PROJECT_MANAGEMENT_TRANSITION_FIELD_REQUIRED",
          `轻语“已解决”流转还要求字段 ${field}，当前缺陷没有可复用值`,
          { field },
        );
      }
      body[field] = value;
    }
    await this.authenticatedRequest(
      session,
      `/tasks/${encodedDefectId}/bug-transition`,
      { method: "POST", body },
    );
    const verifiedPayload = await this.authenticatedRequest(
      session,
      `/tasks/${encodedDefectId}/bug-transitions`,
    );
    const verifiedStatus =
      verifiedPayload?.current_status || verifiedPayload?.data?.current_status;
    if (!resolvedStatus(verifiedStatus)) {
      throw new HttpError(
        409,
        "PROJECT_MANAGEMENT_RESOLUTION_NOT_VERIFIED",
        "轻语没有确认缺陷已进入“已解决”状态",
      );
    }
    const status = statusIdentity(verifiedStatus);
    return {
      defectId: String(defectId),
      status: status.name || status.key || "已解决",
      alreadyResolved: false,
    };
  }
}
