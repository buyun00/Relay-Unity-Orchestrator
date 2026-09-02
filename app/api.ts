import {
  EMPTY_SNAPSHOT,
  type HostMetricsSnapshot,
  type PipelineEvent,
  type Snapshot,
} from "./types";

const API_KEY = "relay-api-base";
const USER_NAME_KEY = "relay-user-name";
const USER_COOKIE_NAME = "relay-user";
const HTTPS_API_PREFIX = "/relay-control";

function persistUserCookie(value: string) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  if (value) {
    document.cookie = `${USER_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  } else {
    document.cookie = `${USER_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  }
}

export function getApiBase(): string {
  if (typeof window === "undefined") return "http://127.0.0.1:4317";
  // HTTPS deployments (for example a Cloudflare Tunnel) must use the
  // same-origin /api route. A previously saved LAN HTTP address would be
  // blocked by the browser as mixed content.
  if (window.location.protocol === "https:")
    return `${window.location.origin}${HTTPS_API_PREFIX}`;
  const saved = window.localStorage.getItem(API_KEY);
  if (saved) return saved.replace(/\/$/, "");
  return `http://${window.location.hostname}:4317`;
}

export function setApiBase(value: string) {
  const effectiveValue =
    window.location.protocol === "https:"
      ? `${window.location.origin}${HTTPS_API_PREFIX}`
      : value.replace(/\/$/, "");
  window.localStorage.setItem(API_KEY, effectiveValue);
  return effectiveValue;
}

export function getUserName(): string {
  if (typeof window === "undefined") return "";
  const userName = window.localStorage.getItem(USER_NAME_KEY)?.trim() ?? "";
  persistUserCookie(userName);
  return userName;
}

export function setUserName(value: string) {
  const normalized = value.trim().replace(/\s+/gu, " ").slice(0, 80);
  if (normalized) window.localStorage.setItem(USER_NAME_KEY, normalized);
  else window.localStorage.removeItem(USER_NAME_KEY);
  persistUserCookie(normalized);
  return normalized;
}

function addUserHeader(headers: Headers) {
  const userName = getUserName();
  if (userName) headers.set("X-Pipeline-User", encodeURIComponent(userName));
}

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = String(init.method || "GET").toUpperCase();
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) addUserHeader(headers);
  const response = await fetch(`${getApiBase()}${path}`, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "include",
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const rawError =
      typeof payload === "object" && payload && "error" in payload
        ? (payload as { error: unknown }).error
        : null;
    const message =
      typeof rawError === "object" && rawError && "message" in rawError
        ? String((rawError as { message: unknown }).message)
        : typeof rawError === "string"
          ? rawError
          : `请求失败（${response.status}）`;
    throw new ApiError(response.status, message, payload);
  }
  return payload as T;
}

export function fetchSnapshot(signal?: AbortSignal) {
  return api<
    Snapshot & {
      server: Snapshot["server"] & {
        adapter?: "hyperv";
        queuePaused?: boolean;
      };
    }
  >("/api/snapshot", { signal }).then((snapshot) => {
    const events = snapshot.events ?? [];
    const latestPhaseByTurn = new Map<string, string>();
    for (const event of events) {
      if (event.turnId && event.phase)
        latestPhaseByTurn.set(event.turnId, event.phase);
    }
    const workers = (snapshot.workers ?? []).map((worker) => ({
      ...worker,
      projectIds:
        worker.projectIds ?? (worker.projectId ? [worker.projectId] : []),
      smbPath: worker.smbPath ?? worker.sharePath,
    }));
    const projects = (snapshot.projects ?? []).map((project) => {
      let unitySkillPort = project.unitySkillPort;
      if (!unitySkillPort && project.unitySkillUrl) {
        try {
          unitySkillPort = Number(new URL(project.unitySkillUrl).port || 80);
        } catch {
          unitySkillPort = 0;
        }
      }
      return {
        ...project,
        unitySkillPort: unitySkillPort || 8090,
        compatibleWorkerIds:
          project.compatibleWorkerIds ??
          workers
            .filter((worker) => worker.projectIds.includes(project.id))
            .map((worker) => worker.id),
      };
    });
    const turns = (snapshot.turns ?? []).map((turn) => {
      const structured =
        typeof turn.codexFinal === "object" && turn.codexFinal
          ? (turn.codexFinal as unknown as NonNullable<typeof turn.result>)
          : turn.result;
      return {
        ...turn,
        result: structured ?? null,
        codexFinal:
          typeof turn.codexFinal === "string"
            ? turn.codexFinal
            : (structured?.summary ?? null),
        phase:
          turn.phase ??
          latestPhaseByTurn.get(turn.id) ??
          (turn.status === "preparing"
            ? "prepare"
            : turn.status === "saving"
              ? "delivery"
              : turn.status),
      };
    });
    const queuePositions = new Map(
      (
        (
          snapshot as unknown as {
            queue?: Array<{ id: string; position: number }>;
          }
        ).queue ?? []
      ).map((turn) => [turn.id, turn.position]),
    );
    const rawOps = snapshot.ops ?? EMPTY_SNAPSHOT.ops;
    const automaticallyRecoveringTaskIds = new Set(
      (rawOps.incidents ?? [])
        .filter(
          (incident) =>
            Boolean(incident.taskId) &&
            !incident.resolvedAt &&
            [
              "open",
              "queued",
              "diagnosing",
              "acting",
              "monitoring",
              "failed",
            ].includes(incident.status),
        )
        .map((incident) => incident.taskId as string),
    );
    const systemThread = {
      ...EMPTY_SNAPSHOT.ops.thread,
      ...rawOps.thread,
      title: rawOps.thread?.title ?? "系统自动恢复",
      isSystem: rawOps.thread?.isSystem ?? true,
      clearedThroughSequence: rawOps.thread?.clearedThroughSequence ?? 0,
    };
    const opsThreads = (
      rawOps.threads?.length ? rawOps.threads : [systemThread]
    ).map((thread) => ({
      ...thread,
      title: thread.title || "新对话",
      isSystem: thread.isSystem ?? thread.id === systemThread.id,
      clearedThroughSequence: thread.clearedThroughSequence ?? 0,
    }));
    return {
      ...snapshot,
      server: {
        ...snapshot.server,
        mode: snapshot.server.mode ?? snapshot.server.adapter ?? "hyperv",
        schedulerRunning:
          snapshot.server.schedulerRunning ?? !snapshot.server.queuePaused,
      },
      projects,
      workers,
      buildDispatches: snapshot.buildDispatches ?? [],
      tasks: (snapshot.tasks ?? []).map((task) => ({
        ...task,
        number: String(task.number).startsWith("TK-")
          ? String(task.number)
          : `TK-${String(task.number).padStart(4, "0")}`,
        status:
          (task.status as string) === "failed"
            ? automaticallyRecoveringTaskIds.has(task.id)
              ? ("recovering" as const)
              : ("needs_attention" as const)
            : task.status,
      })),
      turns: turns.map((turn) => ({
        ...turn,
        queuePosition:
          turn.queuePosition ?? queuePositions.get(turn.id) ?? null,
      })),
      events,
      ops: {
        ...rawOps,
        thread: systemThread,
        threads: opsThreads,
        turns: rawOps.turns ?? [],
        incidents: rawOps.incidents ?? [],
        actions: rawOps.actions ?? [],
        repairs: rawOps.repairs ?? [],
      },
    };
  });
}

export async function fetchHostMetrics(signal?: AbortSignal) {
  const response = await fetch("/_relay/host-metrics", {
    cache: "no-store",
    signal,
  });
  const payload = (await response.json()) as
    HostMetricsSnapshot | { error?: { message?: string } };
  if (!response.ok || !("sampledAt" in payload)) {
    throw new ApiError(
      response.status,
      "error" in payload
        ? (payload.error?.message ?? "宿主机性能采样暂不可用")
        : "宿主机性能采样暂不可用",
      payload,
    );
  }
  return payload;
}

export function fetchTaskEvents(taskId: string) {
  return api<{ events?: PipelineEvent[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}`,
  ).then((payload) => payload.events ?? []);
}

export async function uploadFile(
  file: File,
): Promise<{ id: string; filename: string }> {
  const headers = new Headers({
    "Content-Type": file.type || "application/octet-stream",
    "X-File-Name": encodeURIComponent(file.name),
  });
  addUserHeader(headers);
  const response = await fetch(`${getApiBase()}/api/uploads`, {
    method: "POST",
    headers,
    body: file,
    credentials: "include",
  });
  const payload = (await response.json()) as {
    error?: string | { message?: string };
    attachment?: { id: string; filename: string };
    id?: string;
    filename?: string;
  };
  if (!response.ok)
    throw new ApiError(
      response.status,
      typeof payload.error === "object"
        ? (payload.error.message ?? "附件上传失败")
        : (payload.error ?? "附件上传失败"),
      payload,
    );
  return (payload.attachment ?? payload) as { id: string; filename: string };
}

export async function subscribeEvents(
  onEvent: (event?: PipelineEvent) => void,
  onDisconnect: () => void,
): Promise<() => void> {
  const source = new EventSource(`${getApiBase()}/api/events`, {
    withCredentials: true,
  });
  const handleEvent = (event: MessageEvent<string>) => {
    try {
      onEvent(JSON.parse(event.data) as PipelineEvent);
    } catch {
      onEvent();
    }
  };
  source.addEventListener("pipeline", handleEvent as EventListener);
  source.addEventListener("message", handleEvent as EventListener);
  source.onopen = () => onEvent();
  source.onerror = onDisconnect;
  return () => source.close();
}
