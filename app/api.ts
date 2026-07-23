import type { Snapshot } from "./types";

const TOKEN_KEY = "relay-admin-token";
const API_KEY = "relay-api-base";

export function getApiBase(): string {
  if (typeof window === "undefined") return "http://127.0.0.1:4317";
  const saved = window.localStorage.getItem(API_KEY);
  if (saved) return saved.replace(/\/$/, "");
  const scheme = window.location.protocol === "https:" ? "https:" : "http:";
  return `${scheme}//${window.location.hostname}:4317`;
}

export function setApiBase(value: string) {
  window.localStorage.setItem(API_KEY, value.replace(/\/$/, ""));
}

export function getToken(): string {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(value: string) {
  if (value) window.sessionStorage.setItem(TOKEN_KEY, value);
  else window.sessionStorage.removeItem(TOKEN_KEY);
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
  const token = getToken();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${getApiBase()}${path}`, {
    ...init,
    headers,
    cache: "no-store",
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

export function fetchSnapshot() {
  return api<
    Snapshot & {
      server: Snapshot["server"] & {
        adapter?: "mock" | "hyperv";
        authRequired?: boolean;
        queuePaused?: boolean;
      };
    }
  >("/api/snapshot").then((snapshot) => {
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
    return {
      ...snapshot,
      server: {
        ...snapshot.server,
        mode: snapshot.server.mode ?? snapshot.server.adapter ?? "mock",
        requiresAuth:
          snapshot.server.requiresAuth ?? snapshot.server.authRequired ?? false,
        schedulerRunning:
          snapshot.server.schedulerRunning ?? !snapshot.server.queuePaused,
      },
      projects,
      workers,
      tasks: (snapshot.tasks ?? []).map((task) => ({
        ...task,
        number: String(task.number).startsWith("TK-")
          ? String(task.number)
          : `TK-${String(task.number).padStart(4, "0")}`,
        status:
          (task.status as string) === "failed"
            ? ("needs_attention" as const)
            : task.status,
      })),
      turns: turns.map((turn) => ({
        ...turn,
        queuePosition:
          turn.queuePosition ?? queuePositions.get(turn.id) ?? null,
      })),
      events,
    };
  });
}

export async function uploadFile(
  file: File,
): Promise<{ id: string; filename: string }> {
  const token = getToken();
  const headers = new Headers({
    "Content-Type": file.type || "application/octet-stream",
    "X-File-Name": encodeURIComponent(file.name),
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${getApiBase()}/api/uploads`, {
    method: "POST",
    headers,
    body: file,
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
  onEvent: () => void,
  onDisconnect: () => void,
): Promise<() => void> {
  const adminToken = getToken();
  let eventToken = "";
  if (adminToken) {
    const session = await api<{ token: string }>("/api/session", {
      method: "POST",
      body: JSON.stringify({ adminToken }),
    });
    eventToken = session.token;
  }
  const query = eventToken ? `?token=${encodeURIComponent(eventToken)}` : "";
  const source = new EventSource(`${getApiBase()}/api/events${query}`);
  source.addEventListener("pipeline", onEvent);
  source.addEventListener("message", onEvent);
  source.onopen = onEvent;
  source.onerror = onDisconnect;
  return () => source.close();
}
