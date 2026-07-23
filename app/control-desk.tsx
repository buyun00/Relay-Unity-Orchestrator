"use client";

import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  Bot,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleDot,
  Clock3,
  Copy,
  Cpu,
  Database,
  FileCode2,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  HardDrive,
  HeartPulse,
  History,
  Inbox,
  Layers3,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Menu,
  MessageSquareText,
  MonitorCog,
  Network,
  OctagonX,
  PanelLeftClose,
  Paperclip,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Square,
  TerminalSquare,
  Trash2,
  Wifi,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  api,
  fetchSnapshot,
  fetchTaskEvents,
  getApiBase,
  getToken,
  setApiBase,
  setToken,
  subscribeEvents,
  uploadFile,
} from "./api";
import {
  EMPTY_SNAPSHOT,
  type HealthState,
  type HostVirtualMachine,
  type PipelineEvent,
  type Project,
  type Snapshot,
  type Task,
  type Turn,
  type Worker,
} from "./types";

type ViewName =
  "dashboard" | "tasks" | "workers" | "projects" | "settings" | "task";
type Toast = {
  id: number;
  kind: "success" | "error" | "info";
  message: string;
};
type ConfirmState = {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  requireText?: string;
  action: () => Promise<void>;
};

const LIVE_TURN = new Set(["queued", "preparing", "running", "saving"]);
const LIVE_TASK = new Set(["queued", "running"]);

const TASK_PRIORITY_OPTIONS = [
  { value: 100, label: "紧急", detail: "优先于其他等级" },
  { value: 10, label: "较高", detail: "优先于普通任务" },
  { value: 0, label: "普通", detail: "按当前队列顺序" },
] as const;

const CODEX_MODEL_OPTIONS = [
  {
    value: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    detail: "最强能力，适合复杂编码与长任务",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    value: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    detail: "能力与成本平衡",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    value: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    detail: "轻量快速，适合高吞吐任务",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "gpt-5.5",
    label: "GPT-5.5",
    detail: "复杂编码与通用工作",
    efforts: ["low", "medium", "high", "xhigh"],
  },
  {
    value: "gpt-5.4",
    label: "GPT-5.4",
    detail: "日常编码任务",
    efforts: ["low", "medium", "high", "xhigh"],
  },
  {
    value: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    detail: "更低成本的简单任务",
    efforts: ["low", "medium", "high", "xhigh"],
  },
  {
    value: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    detail: "近实时快速编码迭代",
    efforts: ["low", "medium", "high", "xhigh"],
  },
] as const;

const CODEX_REASONING_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
  { value: "ultra", label: "Ultra" },
] as const;

function codexModelLabel(value: string) {
  return (
    CODEX_MODEL_OPTIONS.find((option) => option.value === value)?.label ?? value
  );
}

function codexReasoningLabel(value: string) {
  return (
    CODEX_REASONING_OPTIONS.find((option) => option.value === value)?.label ??
    value
  );
}

function StyledSelect({
  label,
  value,
  options,
  onChange,
  description,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string; detail?: string }>;
  onChange: (value: string) => void;
  description?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selected =
    options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="form-field">
      <span>{label}</span>
      <div className="styled-select" ref={containerRef}>
        <button
          type="button"
          className="styled-select-trigger"
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp"].includes(event.key)) {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          <span>{selected?.label ?? value}</span>
          <ChevronDown className={open ? "rotated" : ""} size={16} />
        </button>
        {open && (
          <div
            className="styled-select-menu"
            role="listbox"
            aria-label={`${label}选项`}
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={cx(
                  "styled-select-option",
                  option.value === value && "selected",
                )}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span>
                  <strong>{option.label}</strong>
                  {option.detail && <small>{option.detail}</small>}
                </span>
                {option.value === value && <Check size={15} />}
              </button>
            ))}
          </div>
        )}
      </div>
      {description && <small>{description}</small>}
    </div>
  );
}

function taskTitleFromContent(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  const firstSentence = normalized.split(/[。！？!?；;]/, 1)[0]?.trim();
  return (firstSentence || normalized || "新任务").slice(0, 60);
}

let idempotencySequence = 0;

function createIdempotencyKey() {
  idempotencySequence = (idempotencySequence + 1) % 1_000_000;
  return [
    "task",
    Date.now().toString(36),
    idempotencySequence.toString(36),
    Math.random().toString(36).slice(2, 12),
  ].join("-");
}

function estimateTaskStart({
  priority,
  project,
  workers,
  turns,
}: {
  priority: number;
  project: Project;
  workers: Worker[];
  turns: Turn[];
}) {
  const compatibleWorkers = workers.filter(
    (worker) =>
      worker.enabled &&
      (worker.projectId === project.id ||
        worker.projectIds?.includes(project.id) ||
        project.compatibleWorkerIds?.includes(worker.id)),
  );
  const readyWorkers = compatibleWorkers.filter(
    (worker) => worker.status === "ready",
  ).length;
  const activeWorkers = compatibleWorkers.filter((worker) =>
    ["busy", "preparing"].includes(worker.status),
  ).length;
  const queuedAhead = turns.filter(
    (turn) =>
      turn.status === "queued" && Number(turn.priority ?? 0) >= priority,
  ).length;

  if (readyWorkers > queuedAhead) return "可立即开始";
  const usableSlots = readyWorkers + activeWorkers;
  if (usableSlots === 0) return "等待工位恢复";

  const turnsUntilStart = Math.max(1, queuedAhead - readyWorkers + 1);
  const waves = Math.max(1, Math.ceil(turnsUntilStart / usableSlots));
  const minutes = waves * 30;
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `约 ${hours} 小时 ${remainder} 分` : `约 ${hours} 小时`;
}

const taskStatusLabel: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  waiting_user: "等待你确认",
  waiting_review: "等待审阅",
  needs_attention: "需要处理",
  closed: "已关闭",
  cancelled: "已取消",
};

const turnStatusLabel: Record<string, string> = {
  queued: "排队中",
  preparing: "准备工位",
  running: "执行中",
  saving: "正在交付",
  success: "已完成",
  failed: "失败，现场已保留",
  cancelled: "已取消",
  interrupted: "已中断",
};

const workerStatusLabel: Record<string, string> = {
  ready: "空闲",
  busy: "使用中",
  preparing: "准备中",
  reserved: "已保留",
  attention: "需要处理",
  offline: "离线",
  stopped: "已关闭",
  restarting: "重启中",
};

const phaseLabel: Record<string, string> = {
  queued: "等待空闲工位",
  queue: "等待空闲工位",
  prepare: "分配并准备工位",
  claimed: "已预留工位",
  restoring: "恢复检查点",
  restore: "恢复 PROJECT_READY 检查点",
  booting: "启动子机",
  guest_check: "检查来宾服务",
  git_prepare: "同步任务分支",
  workspace: "同步任务分支",
  unity_prepare: "等待 Unity 与 Skill",
  unity: "等待 Unity 与 Skill",
  codex: "Codex 执行中",
  unity_settle: "Unity 保存与刷新",
  "unity-save": "保存 Unity 资产",
  validating: "Unity 验证中",
  committing: "创建提交",
  commit: "创建提交",
  pushing: "推送并核验远程 SHA",
  push: "推送并核验远程 SHA",
  delivery: "持久化本轮交付",
  releasing: "恢复基线并释放工位",
  release: "恢复基线并释放工位",
  released: "工位已释放",
  delivered: "远程分支已核验",
  done: "交付完成",
};

const phaseSequence = [
  "prepare",
  "restore",
  "workspace",
  "unity",
  "codex",
  "delivery",
  "unity-save",
  "commit",
  "push",
  "release",
  "delivered",
  "released",
];

const navItems: { view: ViewName; label: string; icon: typeof Activity }[] = [
  { view: "dashboard", label: "调度台", icon: LayoutDashboard },
  { view: "tasks", label: "任务", icon: MessageSquareText },
  { view: "workers", label: "工位", icon: Server },
  { view: "projects", label: "项目", icon: FolderGit2 },
  { view: "settings", label: "系统", icon: Settings },
];

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function relativeTime(value?: string | null) {
  if (!value) return "—";
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return value;
  if (diff < 15_000) return "刚刚";
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function compactSha(sha?: string | null) {
  return sha ? sha.slice(0, 8) : "尚未提交";
}

function compareEvents(a: PipelineEvent, b: PipelineEvent) {
  const left = Number(a.id);
  const right = Number(b.id);
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  return a.createdAt.localeCompare(b.createdAt);
}

function mergePipelineEvent(events: PipelineEvent[], incoming: PipelineEvent) {
  if (events.some((event) => String(event.id) === String(incoming.id)))
    return events;
  return [...events, incoming].sort(compareEvents);
}

function readableCodexMessage(message: string) {
  const value = message.trim();
  if (!value.startsWith("{")) return value;
  try {
    const parsed = JSON.parse(value) as { summary?: unknown };
    if (typeof parsed.summary === "string" && parsed.summary.trim())
      return parsed.summary.trim();
  } catch {
    /* A normal Codex message can begin with a brace. */
  }
  return value;
}

function projectById(snapshot: Snapshot, id: string) {
  return snapshot.projects.find((project) => project.id === id);
}

function latestTurn(snapshot: Snapshot, taskId: string) {
  return snapshot.turns
    .filter((turn) => turn.taskId === taskId)
    .sort((a, b) => b.sequence - a.sequence)[0];
}

function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <span className={cx("status-badge", `status-${status}`)}>
      <span className="status-dot" aria-hidden="true" />
      {label ??
        taskStatusLabel[status] ??
        turnStatusLabel[status] ??
        workerStatusLabel[status] ??
        status}
    </span>
  );
}

function IconButton({
  label,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <button className="icon-button" aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof Inbox;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={24} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

function useDialogFocusTrap(onClose: () => void) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    window.setTimeout(() => focusable()[0]?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, []);
  return dialogRef;
}

function HealthStrip({
  health,
  detailed = false,
}: {
  health: Worker["health"];
  detailed?: boolean;
}) {
  const items: Array<[keyof Worker["health"], string]> = [
    ["vm", "VM"],
    ["heartbeat", "Heartbeat"],
    ["smb", "SMB"],
    ["unity", "Unity"],
    ["skill", "Skill"],
  ];
  return (
    <div className={cx("health-strip", detailed && "health-detailed")}>
      {items.map(([key, label]) => {
        const value = health?.[key] ?? "unknown";
        return (
          <span
            key={key}
            className={cx("health-item", `health-${value}`)}
            title={`${label}: ${value}`}
          >
            <span aria-hidden="true">
              {value === "healthy" ? (
                <Check size={11} />
              ) : value === "error" ? (
                <X size={11} />
              ) : (
                <Circle size={9} />
              )}
            </span>
            {detailed && <small>{label}</small>}
          </span>
        );
      })}
    </div>
  );
}

export default function ControlDesk() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [taskEventsById, setTaskEventsById] = useState<
    Record<string, PipelineEvent[]>
  >({});
  const [connected, setConnected] = useState(false);
  const [lastConnectedAt, setLastConnectedAt] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [view, setView] = useState<ViewName>("dashboard");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [projectEditorOpen, setProjectEditorOpen] = useState(false);
  const [workerEditorOpen, setWorkerEditorOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editingWorker, setEditingWorker] = useState<Worker | null>(null);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [busy, setBusy] = useState(false);
  const toastId = useRef(0);
  const lastNotifiedEvent = useRef<number | string | null>(null);

  const notify = useCallback(
    (message: string, kind: Toast["kind"] = "success") => {
      const id = ++toastId.current;
      setToasts((items) => [...items, { id, message, kind }]);
      window.setTimeout(
        () => setToasts((items) => items.filter((item) => item.id !== id)),
        4200,
      );
    },
    [],
  );

  const refresh = useCallback(
    async (silent = false) => {
      try {
        const next = await fetchSnapshot();
        setSnapshot({ ...next, server: { ...next.server, connected: true } });
        setConnected(true);
        setAuthRequired(Boolean(next.server.requiresAuth));
        setLastConnectedAt(new Date().toISOString());
        const newestEvent = next.events.at(-1);
        if (newestEvent) {
          if (
            lastNotifiedEvent.current !== null &&
            lastNotifiedEvent.current !== newestEvent.id &&
            typeof Notification !== "undefined" &&
            Notification.permission === "granted" &&
            (newestEvent.level === "error" ||
              /delivered|failed|attention/.test(newestEvent.type))
          ) {
            new Notification(
              newestEvent.level === "error"
                ? "Relay 需要处理"
                : "Relay 轮次已交付",
              {
                body: newestEvent.message,
                icon: "/favicon.svg",
                tag: `relay-${newestEvent.id}`,
              },
            );
          }
          lastNotifiedEvent.current = newestEvent.id;
        }
      } catch (error) {
        setConnected(false);
        if (error instanceof ApiError && error.status === 401)
          setAuthRequired(true);
        if (!silent && !(error instanceof ApiError && error.status === 401)) {
          notify(
            error instanceof Error ? error.message : "无法连接调度服务",
            "error",
          );
        }
      }
    },
    [notify],
  );

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(true), 0);
    const timer = window.setInterval(() => void refresh(true), 4_000);
    let unsubscribe = () => {};
    let disposed = false;
    void subscribeEvents(
      (event) => {
        if (event?.taskId) {
          setTaskEventsById((current) => ({
            ...current,
            [event.taskId!]: mergePipelineEvent(
              current[event.taskId!] ?? [],
              event,
            ),
          }));
        }
        void refresh(true);
      },
      () => void refresh(true),
    )
      .then((cleanup) => {
        if (disposed) cleanup();
        else unsubscribe = cleanup;
      })
      .catch(() => void refresh(true));
    return () => {
      disposed = true;
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [refresh]);

  useEffect(() => {
    if (!selectedTaskId) return;
    let disposed = false;
    const load = async () => {
      try {
        const events = await fetchTaskEvents(selectedTaskId);
        if (!disposed) {
          setTaskEventsById((current) => ({
            ...current,
            [selectedTaskId]: events.sort(compareEvents),
          }));
        }
      } catch {
        /* The global snapshot remains available while the detail request retries. */
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 4_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [selectedTaskId]);

  useEffect(() => {
    const applyLocation = () => {
      const params = new URLSearchParams(window.location.search);
      const nextView = params.get("view") as ViewName | null;
      const taskId = params.get("task");
      if (
        nextView &&
        [
          "dashboard",
          "tasks",
          "workers",
          "projects",
          "settings",
          "task",
        ].includes(nextView)
      ) {
        setView(nextView);
        if (nextView === "task" && taskId) setSelectedTaskId(taskId);
      }
    };
    applyLocation();
    window.addEventListener("popstate", applyLocation);
    return () => window.removeEventListener("popstate", applyLocation);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCreateTaskOpen(true);
      }
      if (event.key === "Escape") {
        setCreateTaskOpen(false);
        setProjectEditorOpen(false);
        setWorkerEditorOpen(false);
        setConfirm(null);
        setMobileNav(false);
      }
      if (
        event.key === "/" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault();
        setView("tasks");
        window.history.pushState({}, "", "?view=tasks");
        window.setTimeout(
          () =>
            document.querySelector<HTMLInputElement>("#task-search")?.focus(),
          30,
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const runMutation = useCallback(
    async (operation: () => Promise<unknown>, successMessage?: string) => {
      setBusy(true);
      try {
        await operation();
        if (successMessage) notify(successMessage);
        await refresh(true);
        return true;
      } catch (error) {
        notify(error instanceof Error ? error.message : "操作失败", "error");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [notify, refresh],
  );

  const navigate = (next: ViewName, id?: string) => {
    setView(next);
    setMobileNav(false);
    if (next === "task" && id) setSelectedTaskId(id);
    const query =
      next === "dashboard"
        ? ""
        : next === "task" && id
          ? `?view=task&task=${encodeURIComponent(id)}`
          : `?view=${next}`;
    window.history.pushState({}, "", `${window.location.pathname}${query}`);
  };

  const selectedTask =
    snapshot.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedWorker =
    snapshot.workers.find((worker) => worker.id === selectedWorkerId) ?? null;

  const workerAction = (worker: Worker, action: string) => {
    const labels: Record<string, string> = {
      start: "启动工位",
      shutdown: "正常关闭工位",
      restart: "重启工位",
      probe: "重新检查状态",
      forceOff: "强制关闭工位",
      restore: "恢复 PROJECT_READY 检查点",
      release: "解除隔离并释放工位",
    };
    const destructive =
      ["forceOff", "restore", "release"].includes(action) ||
      (action === "restart" &&
        ["busy", "attention", "reserved"].includes(worker.status));
    const execute = () =>
      runMutation(
        () =>
          api(`/api/workers/${worker.id}/action`, {
            method: "POST",
            body: JSON.stringify({
              action,
              force: destructive,
              confirmName: destructive ? worker.name : undefined,
            }),
          }),
        `${labels[action] ?? action}指令已提交`,
      ).then(() => undefined);
    if (action === "probe") {
      void execute();
      return;
    }
    setConfirm({
      title: labels[action] ?? "确认操作",
      description: destructive
        ? "此操作可能终止 Unity 或恢复检查点，并永久丢失仅存在子机现场的未推送修改。请先确认远程任务分支已经包含所有要保留的内容。"
        : `确认对 ${worker.name} 执行“${labels[action]}”吗？操作会写入审计记录。`,
      confirmLabel: labels[action] ?? "确认",
      danger: destructive,
      requireText: destructive ? worker.name : undefined,
      action: execute,
    });
  };

  return (
    <div className={cx("app-shell", sidebarCompact && "sidebar-compact")}>
      <aside className={cx("sidebar", mobileNav && "mobile-open")}>
        <div className="brand-row">
          <div className="brand-mark">
            <Layers3 size={20} />
          </div>
          <div className="brand-copy">
            <strong>RELAY</strong>
            <span>Unity 调度台</span>
          </div>
          <IconButton
            label="收起导航"
            onClick={() => setSidebarCompact((value) => !value)}
          >
            <PanelLeftClose size={18} />
          </IconButton>
        </div>

        <button
          className="primary-action sidebar-create"
          onClick={() => setCreateTaskOpen(true)}
        >
          <Plus size={18} />
          <span>发起任务</span>
          <kbd>Ctrl K</kbd>
        </button>

        <nav aria-label="主导航">
          {navItems.map(({ view: itemView, label, icon: Icon }) => (
            <button
              key={itemView}
              className={cx("nav-item", view === itemView && "active")}
              onClick={() => navigate(itemView)}
              aria-current={view === itemView ? "page" : undefined}
            >
              <Icon size={19} />
              <span>{label}</span>
              {itemView === "tasks" &&
                snapshot.tasks.filter((task) => LIVE_TASK.has(task.status))
                  .length > 0 && (
                  <em>
                    {
                      snapshot.tasks.filter((task) =>
                        LIVE_TASK.has(task.status),
                      ).length
                    }
                  </em>
                )}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div
            className={cx("connection-pill", connected ? "online" : "offline")}
          >
            {connected ? <Wifi size={15} /> : <WifiOff size={15} />}
            <div>
              <strong>{connected ? "调度服务正常" : "服务已断开"}</strong>
              <span>真实 Hyper-V</span>
            </div>
          </div>
          <div className="profile-row">
            <span className="avatar">L</span>
            <div>
              <strong>Lin</strong>
              <span>管理员</span>
            </div>
            <ShieldCheck size={17} />
          </div>
        </div>
      </aside>

      <main className="main-stage">
        {!connected && (
          <div className="service-banner" role="alert">
            <WifiOff size={17} />
            <span>
              调度服务已断开。页面仍显示最后一次状态
              {lastConnectedAt ? `（${relativeTime(lastConnectedAt)}）` : ""}
              ，暂时无法发起或控制任务。
            </span>
            <button onClick={() => void refresh()}>重新连接</button>
          </div>
        )}
        {authRequired && !getToken() && (
          <div className="service-banner warning" role="alert">
            <LockKeyhole size={17} />
            <span>
              宿主机已启用访问令牌。请在“系统”页面输入令牌后重新连接。
            </span>
            <button onClick={() => navigate("settings")}>前往设置</button>
          </div>
        )}

        <header className="topbar">
          <IconButton
            label="打开导航"
            onClick={() => setMobileNav((value) => !value)}
          >
            <Menu size={20} />
          </IconButton>
          <div className="topbar-context">
            <span>Relay /</span>
            <strong>
              {view === "task"
                ? (selectedTask?.number ?? "任务")
                : navItems.find((item) => item.view === view)?.label}
            </strong>
          </div>
          <div className="topbar-actions">
            <button
              className="command-hint"
              onClick={() => {
                navigate("tasks");
                window.setTimeout(
                  () =>
                    document
                      .querySelector<HTMLInputElement>("#task-search")
                      ?.focus(),
                  30,
                );
              }}
            >
              <Search size={16} />
              <span>搜索任务</span>
              <kbd>/</kbd>
            </button>
            <IconButton label="通知设置" onClick={() => navigate("settings")}>
              <Bell size={18} />
            </IconButton>
            <button
              className="primary-action compact"
              onClick={() => setCreateTaskOpen(true)}
            >
              <Plus size={17} />
              发起任务
            </button>
          </div>
        </header>

        <div className="page-scroll">
          {view === "dashboard" && (
            <Dashboard
              snapshot={snapshot}
              onTask={(id) => navigate("task", id)}
              onWorker={(id) => {
                setSelectedWorkerId(id);
                navigate("workers");
              }}
              onCreate={() => setCreateTaskOpen(true)}
            />
          )}
          {view === "tasks" && (
            <TasksPage
              snapshot={snapshot}
              onTask={(id) => navigate("task", id)}
              onCreate={() => setCreateTaskOpen(true)}
            />
          )}
          {view === "task" && selectedTask && (
            <TaskDetail
              snapshot={snapshot}
              task={selectedTask}
              events={
                taskEventsById[selectedTask.id] ??
                snapshot.events.filter(
                  (event) => event.taskId === selectedTask.id,
                )
              }
              busy={busy}
              onBack={() => navigate("tasks")}
              onRefresh={() => void refresh()}
              onMessage={async (message) => {
                const ok = await runMutation(
                  () =>
                    api(`/api/tasks/${selectedTask.id}/messages`, {
                      method: "POST",
                      body: JSON.stringify({ message }),
                    }),
                  "新的微调已加入执行队列",
                );
                return ok;
              }}
              onCancel={() =>
                setConfirm({
                  title: "停止当前轮次",
                  description:
                    "排队中的轮次会被移除；若执行已经开始，系统会立即中止并保留工位现场，不会自动保存、推送或恢复检查点。任务历史不会删除。",
                  confirmLabel: "停止本轮",
                  danger: true,
                  action: () =>
                    runMutation(
                      () =>
                        api(`/api/tasks/${selectedTask.id}/cancel`, {
                          method: "POST",
                        }),
                      "停止请求已提交",
                    ).then(() => undefined),
                })
              }
              onRetry={() =>
                void runMutation(
                  () =>
                    api(`/api/tasks/${selectedTask.id}/retry`, {
                      method: "POST",
                    }),
                  "本轮已重新加入队列",
                )
              }
              onClose={() =>
                setConfirm({
                  title: "结束这条长期任务",
                  description:
                    "任务会被标记为已关闭，完整对话、每轮结果、分支和提交仍然保留。关闭后也可以重新打开并继续微调。",
                  confirmLabel: "确认完成",
                  action: () =>
                    runMutation(
                      () =>
                        api(`/api/tasks/${selectedTask.id}/close`, {
                          method: "POST",
                        }),
                      "任务已关闭",
                    ).then(() => undefined),
                })
              }
              onReopen={() =>
                void runMutation(
                  () =>
                    api(`/api/tasks/${selectedTask.id}/reopen`, {
                      method: "POST",
                    }),
                  "任务已重新打开，可以继续微调",
                )
              }
            />
          )}
          {view === "task" && !selectedTask && (
            <EmptyState
              icon={MessageSquareText}
              title="没有找到这条任务"
              description="它可能已被移除，或者当前快照尚未同步。"
              action={
                <button
                  className="secondary-action"
                  onClick={() => navigate("tasks")}
                >
                  返回任务列表
                </button>
              }
            />
          )}
          {view === "workers" && (
            <WorkersPage
              snapshot={snapshot}
              selected={selectedWorker}
              onSelect={setSelectedWorkerId}
              onAction={workerAction}
              onCreate={() => {
                setEditingWorker(null);
                setWorkerEditorOpen(true);
              }}
              onEdit={(worker) => {
                setEditingWorker(worker);
                setWorkerEditorOpen(true);
              }}
            />
          )}
          {view === "projects" && (
            <ProjectsPage
              snapshot={snapshot}
              onCreate={() => {
                setEditingProject(null);
                setProjectEditorOpen(true);
              }}
              onEdit={(project) => {
                setEditingProject(project);
                setProjectEditorOpen(true);
              }}
              onDelete={(project) =>
                setConfirm({
                  title: `删除项目 ${project.name}`,
                  description:
                    "仅允许删除没有关联任务和工位的项目配置。仓库、虚拟机和检查点不会被删除。",
                  confirmLabel: "删除配置",
                  danger: true,
                  requireText: project.name,
                  action: () =>
                    runMutation(
                      () =>
                        api(`/api/projects/${project.id}`, {
                          method: "DELETE",
                        }),
                      "项目配置已删除",
                    ).then(() => undefined),
                })
              }
            />
          )}
          {view === "settings" && (
            <SettingsPage
              snapshot={snapshot}
              connected={connected}
              onSaved={() => void refresh()}
              notify={notify}
            />
          )}
        </div>
      </main>

      {createTaskOpen && (
        <CreateTaskModal
          projects={snapshot.projects.filter((project) => project.enabled)}
          workers={snapshot.workers}
          turns={snapshot.turns}
          busy={busy}
          onClose={() => setCreateTaskOpen(false)}
          onSubmit={async (payload, files) => {
            setBusy(true);
            try {
              const attachments = [];
              for (const file of files)
                attachments.push(await uploadFile(file));
              const message = String(payload.requirement ?? "");
              const idempotencyKey = String(payload.idempotencyKey ?? "");
              const taskPayload = { ...payload };
              delete taskPayload.idempotencyKey;
              delete taskPayload.requirement;
              const created = await api<{ task: Task } | Task>("/api/tasks", {
                method: "POST",
                headers: { "Idempotency-Key": idempotencyKey },
                body: JSON.stringify({
                  ...taskPayload,
                  message,
                  attachmentIds: attachments.map((item) => item.id),
                }),
              });
              const task = "task" in created ? created.task : created;
              notify("任务已创建并加入执行队列");
              setCreateTaskOpen(false);
              await refresh(true);
              navigate("task", task.id);
            } catch (error) {
              notify(
                error instanceof Error ? error.message : "创建任务失败",
                "error",
              );
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {projectEditorOpen && (
        <ProjectEditor
          project={editingProject}
          workers={snapshot.workers}
          busy={busy}
          onClose={() => setProjectEditorOpen(false)}
          onSave={async (payload) => {
            const ok = await runMutation(
              () =>
                api(
                  editingProject
                    ? `/api/projects/${editingProject.id}`
                    : "/api/projects",
                  {
                    method: editingProject ? "PATCH" : "POST",
                    body: JSON.stringify(payload),
                  },
                ),
              editingProject ? "项目配置已更新" : "项目已创建",
            );
            if (ok) setProjectEditorOpen(false);
          }}
        />
      )}

      {workerEditorOpen && (
        <WorkerEditor
          worker={editingWorker}
          projects={snapshot.projects}
          virtualMachines={
            snapshot.server.runtime?.hyperv.virtualMachines ?? []
          }
          busy={busy}
          onClose={() => setWorkerEditorOpen(false)}
          onSave={async (payload) => {
            const ok = await runMutation(
              () =>
                api(
                  editingWorker
                    ? `/api/workers/${editingWorker.id}`
                    : "/api/workers",
                  {
                    method: editingWorker ? "PATCH" : "POST",
                    body: JSON.stringify(payload),
                  },
                ),
              editingWorker ? "工位配置已更新" : "工位已添加",
            );
            if (ok) setWorkerEditorOpen(false);
          }}
        />
      )}

      {confirm && (
        <ConfirmDialog
          state={confirm}
          busy={busy}
          onClose={() => setConfirm(null)}
        />
      )}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={cx("toast", toast.kind)}>
            {toast.kind === "success" ? (
              <CheckCircle2 size={17} />
            ) : toast.kind === "error" ? (
              <AlertTriangle size={17} />
            ) : (
              <CircleDot size={17} />
            )}
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Dashboard({
  snapshot,
  onTask,
  onWorker,
  onCreate,
}: {
  snapshot: Snapshot;
  onTask: (id: string) => void;
  onWorker: (id: string) => void;
  onCreate: () => void;
}) {
  const ready = snapshot.workers.filter(
    (worker) => worker.status === "ready",
  ).length;
  const queued = snapshot.turns.filter(
    (turn) => turn.status === "queued",
  ).length;
  const active = snapshot.turns.filter((turn) =>
    ["preparing", "running", "saving"].includes(turn.status),
  );
  const lanes = [
    {
      key: "queued",
      label: "等待",
      turns: snapshot.turns.filter((turn) => turn.status === "queued"),
      icon: Clock3,
    },
    {
      key: "prepare",
      label: "准备",
      turns: active.filter((turn) => turn.status === "preparing"),
      icon: RefreshCw,
    },
    {
      key: "run",
      label: "执行",
      turns: active.filter((turn) => turn.status === "running"),
      icon: Bot,
    },
    {
      key: "deliver",
      label: "交付",
      turns: active.filter((turn) => turn.status === "saving"),
      icon: GitCommitHorizontal,
    },
  ];
  return (
    <div className="page dashboard-page">
      <section className="hero-heading">
        <div>
          <span className="eyebrow">
            <Activity size={14} /> LIVE ORCHESTRATION
          </span>
          <h1>下午好，Lin。</h1>
          <p>
            当前 <strong>{ready} 个工位空闲</strong>，
            <strong>{queued} 个执行轮次排队中</strong>
            。对话和代码分支会持续保留。
          </p>
        </div>
        <div className="hero-system-state">
          <span className="pulse-dot" />
          <div>
            <strong>真实调度已启用</strong>
            <small>
              调度器{" "}
              {snapshot.server.schedulerRunning === false
                ? "已暂停"
                : "正在运行"}
            </small>
          </div>
        </div>
      </section>

      <div className="dashboard-grid">
        <section className="workspace-panel task-rail-panel">
          <div className="section-heading">
            <div>
              <span className="section-kicker">执行流</span>
              <h2>实时任务轨道</h2>
            </div>
            <span className="live-label">
              <span />
              实时
            </span>
          </div>
          <div className="task-rail">
            {lanes.map((lane, index) => (
              <div
                className={cx("rail-lane", `lane-${lane.key}`)}
                key={lane.key}
              >
                <div className="lane-head">
                  <span className="lane-icon">
                    <lane.icon size={16} />
                  </span>
                  <strong>{lane.label}</strong>
                  <em>{lane.turns.length}</em>
                  {index < lanes.length - 1 && (
                    <ArrowRight className="lane-arrow" size={15} />
                  )}
                </div>
                <div className="lane-body">
                  {lane.turns.slice(0, 4).map((turn) => {
                    const task = snapshot.tasks.find(
                      (item) => item.id === turn.taskId,
                    );
                    const worker = snapshot.workers.find(
                      (item) => item.id === turn.workerId,
                    );
                    if (!task) return null;
                    return (
                      <button
                        className="turn-capsule"
                        key={turn.id}
                        onClick={() => onTask(task.id)}
                      >
                        <span className="capsule-code">
                          {task.number} · 第 {turn.sequence} 轮
                        </span>
                        <strong>{task.title}</strong>
                        <span className="capsule-meta">
                          {turn.status === "queued"
                            ? `前方 ${Math.max(0, (turn.queuePosition ?? 1) - 1)} 个轮次`
                            : (phaseLabel[turn.phase ?? ""] ??
                              turnStatusLabel[turn.status])}
                        </span>
                        <span className="capsule-foot">
                          <i />
                          {worker?.name ??
                            projectById(snapshot, task.projectId)?.name ??
                            "等待分配"}
                        </span>
                      </button>
                    );
                  })}
                  {lane.turns.length === 0 && (
                    <div className="lane-empty">
                      <span />
                      暂无
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          {snapshot.turns.filter((turn) => LIVE_TURN.has(turn.status))
            .length === 0 && (
            <div className="rail-zero-state">
              <Zap size={22} />
              <div>
                <strong>流水线现在很安静</strong>
                <span>空闲工位会在新任务发起后立即开始准备。</span>
              </div>
              <button onClick={onCreate}>
                发起第一个任务 <ArrowRight size={15} />
              </button>
            </div>
          )}
        </section>

        <section className="workspace-panel worker-pool-panel">
          <div className="section-heading">
            <div>
              <span className="section-kicker">资源层</span>
              <h2>工位池</h2>
            </div>
            <span className="soft-count">{snapshot.workers.length}</span>
          </div>
          <div className="worker-node-list">
            {snapshot.workers.map((worker) => {
              const turn = snapshot.turns.find(
                (item) => item.id === worker.currentTurnId,
              );
              const task =
                turn && snapshot.tasks.find((item) => item.id === turn.taskId);
              return (
                <button
                  className="worker-node"
                  key={worker.id}
                  onClick={() => onWorker(worker.id)}
                >
                  <span className={cx("worker-orb", `worker-${worker.status}`)}>
                    {worker.status === "preparing" ? (
                      <LoaderCircle size={17} />
                    ) : (
                      <Server size={16} />
                    )}
                  </span>
                  <span className="worker-node-copy">
                    <strong>{worker.name}</strong>
                    <small>
                      {task
                        ? `${task.number} · 第 ${turn?.sequence} 轮`
                        : workerStatusLabel[worker.status]}
                    </small>
                  </span>
                  <HealthStrip health={worker.health} />
                  <ChevronRight size={16} />
                </button>
              );
            })}
            {snapshot.workers.length === 0 && (
              <EmptyState
                icon={Server}
                title="还没有工位"
                description="添加 Hyper-V 工位后，它们会在这里形成可分配的资源池。"
              />
            )}
          </div>
        </section>
      </div>

      <section className="event-stream-section">
        <div className="section-heading horizontal">
          <div>
            <span className="section-kicker">审计流</span>
            <h2>最近发生</h2>
          </div>
          <span className="stream-caption">保留最近 120 条</span>
        </div>
        <EventStream
          events={snapshot.events.slice(-8).reverse()}
          tasks={snapshot.tasks}
          onTask={onTask}
        />
      </section>
    </div>
  );
}

function EventStream({
  events,
  tasks,
  onTask,
}: {
  events: PipelineEvent[];
  tasks: Task[];
  onTask?: (id: string) => void;
}) {
  if (events.length === 0)
    return (
      <EmptyState
        icon={History}
        title="还没有执行事件"
        description="任务开始后，恢复、Codex、Unity、Git 和工位操作都会记录在这里。"
      />
    );
  return (
    <div className="event-stream">
      {events.map((event) => {
        const task = tasks.find((item) => item.id === event.taskId);
        return (
          <button
            key={event.id}
            className="event-row"
            onClick={() => task && onTask?.(task.id)}
            disabled={!task}
          >
            <time>
              {new Intl.DateTimeFormat("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
              }).format(new Date(event.createdAt))}
            </time>
            <span className={cx("event-mark", event.level)} />
            <span className="event-message">
              {task && <strong>{task.number}</strong>}
              {event.message}
            </span>
            <span className="event-phase">
              {event.phase
                ? (phaseLabel[event.phase] ?? event.phase)
                : event.type}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function TasksPage({
  snapshot,
  onTask,
  onCreate,
}: {
  snapshot: Snapshot;
  onTask: (id: string) => void;
  onCreate: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const filters = [
    ["all", "全部"],
    ["running", "执行中"],
    ["queued", "排队中"],
    ["waiting_user", "等待我确认"],
    ["needs_attention", "异常"],
    ["closed", "已关闭"],
  ];
  const tasks = snapshot.tasks.filter((task) => {
    if (filter !== "all" && task.status !== filter) return false;
    const project = projectById(snapshot, task.projectId);
    const haystack =
      `${task.number} ${task.title} ${task.branchName} ${task.latestCommitSha ?? ""} ${project?.name ?? ""}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });
  return (
    <div className="page tasks-page">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">PERSISTENT TASKS</span>
          <h1>长期任务</h1>
          <p>
            每条任务保存完整对话、固定分支和所有执行轮次；释放工位不会丢历史。
          </p>
        </div>
        <button className="primary-action" onClick={onCreate}>
          <Plus size={18} />
          发起任务
        </button>
      </section>
      <div className="list-toolbar">
        <div className="filter-tabs">
          {filters.map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? "active" : ""}
              onClick={() => setFilter(value)}
            >
              {label}
              <em>
                {value === "all"
                  ? snapshot.tasks.length
                  : snapshot.tasks.filter((task) => task.status === value)
                      .length}
              </em>
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={16} />
          <input
            id="task-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索编号、标题、分支或 commit"
          />
        </label>
      </div>
      <div className="task-archive-list">
        {tasks.map((task) => {
          const turn = latestTurn(snapshot, task.id);
          const project = projectById(snapshot, task.projectId);
          const worker = snapshot.workers.find(
            (item) => item.id === turn?.workerId,
          );
          const allTurns = snapshot.turns.filter(
            (item) => item.taskId === task.id,
          );
          return (
            <button
              className="task-archive-row"
              key={task.id}
              onClick={() => onTask(task.id)}
            >
              <div className="archive-signal">
                <span className={cx("archive-dot", `status-${task.status}`)} />
                <span />
              </div>
              <div className="archive-main">
                <div className="archive-title">
                  <span>{task.number}</span>
                  <h3>{task.title}</h3>
                  <StatusBadge status={task.status} />
                </div>
                <div className="archive-meta">
                  <span>{project?.name ?? "未知项目"}</span>
                  <i />
                  <code>{task.branchName}</code>
                  <i />
                  <span>{allTurns.length} 轮</span>
                </div>
              </div>
              <div className="archive-current">
                <strong>
                  {turn
                    ? `第 ${turn.sequence} 轮 · ${turnStatusLabel[turn.status]}`
                    : "尚未执行"}
                </strong>
                <span>
                  {worker?.name ?? compactSha(task.latestCommitSha)} ·{" "}
                  {relativeTime(task.updatedAt)}
                </span>
              </div>
              <ChevronRight size={18} />
            </button>
          );
        })}
        {tasks.length === 0 && (
          <EmptyState
            icon={MessageSquareText}
            title={snapshot.tasks.length ? "没有匹配的任务" : "还没有长期任务"}
            description={
              snapshot.tasks.length
                ? "换一个关键词或状态筛选试试。"
                : "发起需求后，系统会自动创建任务分支和第一个执行轮次。"
            }
            action={
              !snapshot.tasks.length ? (
                <button className="primary-action" onClick={onCreate}>
                  <Plus size={17} />
                  发起任务
                </button>
              ) : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

function TaskDetail({
  snapshot,
  task,
  events,
  busy,
  onBack,
  onRefresh,
  onMessage,
  onCancel,
  onRetry,
  onClose,
  onReopen,
}: {
  snapshot: Snapshot;
  task: Task;
  events: PipelineEvent[];
  busy: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onMessage: (message: string) => Promise<boolean>;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
  onReopen: () => void;
}) {
  const turns = snapshot.turns
    .filter((turn) => turn.taskId === task.id)
    .sort((a, b) => a.sequence - b.sequence);
  const current = turns.at(-1);
  const project = projectById(snapshot, task.projectId);
  const worker = snapshot.workers.find((item) => item.id === current?.workerId);
  const [message, setMessage] = useState("");
  const [logsOpen, setLogsOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const active = Boolean(current && LIVE_TURN.has(current.status));
  const closed = task.status === "closed";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim() || active || closed) return;
    setSending(true);
    const ok = await onMessage(message.trim());
    if (ok) setMessage("");
    setSending(false);
  };
  return (
    <div className="task-detail-page">
      <div className="task-detail-head">
        <button className="back-button" onClick={onBack}>
          <ChevronLeft size={17} />
          任务
        </button>
        <div className="task-identity">
          <div>
            <span>{task.number}</span>
            <StatusBadge status={task.status} />
          </div>
          <h1>{task.title}</h1>
          <div className="identity-meta">
            <span>
              <FolderGit2 size={14} />
              {project?.name}
            </span>
            <code>
              <GitBranch size={13} />
              {task.branchName}
            </code>
            <button
              onClick={() =>
                void navigator.clipboard.writeText(task.branchName)
              }
              title="复制分支"
            >
              <Copy size={13} />
            </button>
          </div>
        </div>
        <div className="task-head-actions">
          <IconButton label="刷新" onClick={onRefresh}>
            <RefreshCw size={17} />
          </IconButton>
          {active ? (
            <button className="secondary-action danger-text" onClick={onCancel}>
              <Square size={14} />
              停止本轮
            </button>
          ) : closed ? (
            <button className="secondary-action" onClick={onReopen}>
              <RotateCcw size={15} />
              重新打开
            </button>
          ) : current?.status === "failed" ? (
            <button className="secondary-action" onClick={onRetry}>
              <RotateCcw size={15} />
              重新排队
            </button>
          ) : (
            <button className="secondary-action" onClick={onClose}>
              <Check size={15} />
              确认完成
            </button>
          )}
        </div>
      </div>

      <div className="task-detail-grid">
        <section className="conversation-surface">
          <div className="conversation-intro">
            <span>
              <History size={14} /> 持久对话
            </span>
            <p>
              这条时间线由平台独立保存，并与 Codex thread{" "}
              <code>
                {task.codexThreadId
                  ? task.codexThreadId.slice(0, 12) + "…"
                  : "将在首轮启动时创建"}
              </code>{" "}
              关联。
            </p>
          </div>
          <div className="conversation-line">
            {turns.map((turn) => (
              <TurnConversation
                key={turn.id}
                turn={turn}
                task={task}
                events={events.filter((event) => event.turnId === turn.id)}
              />
            ))}
            {turns.length === 0 && (
              <EmptyState
                icon={MessageSquareText}
                title="等待第一个轮次"
                description="任务已经创建，调度器即将把它加入队列。"
              />
            )}
          </div>
          <form
            className={cx(
              "message-composer",
              (active || closed) && "composer-disabled",
            )}
            onSubmit={submit}
          >
            <div className="composer-label">
              <MessageSquareText size={15} />
              <strong>
                {closed
                  ? "任务已经关闭"
                  : active
                    ? "本轮仍在执行"
                    : "继续在这条任务中微调"}
              </strong>
              <span>
                {closed
                  ? "重新打开后可追加"
                  : active
                    ? "完成后即可追加"
                    : `将创建第 ${(current?.sequence ?? 0) + 1} 轮`}
              </span>
            </div>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              disabled={active || closed || sending}
              placeholder={
                closed
                  ? "完整历史仍然保留；点击“重新打开”即可继续…"
                  : active
                    ? "当前轮次结束后可继续输入微调需求…"
                    : "例如：按钮再向左移动 8px，其他布局不要变…"
              }
            />
            <div className="composer-foot">
              <span>
                <GitBranch size={13} />
                沿用 {task.branchName} 与原 Codex 对话
              </span>
              {closed ? (
                <button
                  type="button"
                  className="primary-action"
                  onClick={onReopen}
                >
                  <RotateCcw size={16} />
                  重新打开
                </button>
              ) : (
                <button
                  className="primary-action"
                  disabled={active || sending || !message.trim()}
                >
                  {sending ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <ArrowRight size={16} />
                  )}
                  追加一轮
                </button>
              )}
            </div>
          </form>
        </section>

        <aside className="execution-inspector">
          <div className="inspector-block live-inspector">
            <div className="inspector-title">
              <div>
                <span>当前执行</span>
                <h2>{current ? `第 ${current.sequence} 轮` : "等待调度"}</h2>
              </div>
              {current && (
                <StatusBadge
                  status={current.status}
                  label={turnStatusLabel[current.status]}
                />
              )}
            </div>
            {current && <PhaseProgress turn={current} />}
            {worker ? (
              <div className="assigned-worker">
                <span className={cx("worker-orb", `worker-${worker.status}`)}>
                  <Server size={16} />
                </span>
                <div>
                  <strong>{worker.name}</strong>
                  <span>{worker.internalIp ?? "内部 IP 未设置"}</span>
                </div>
                <HealthStrip health={worker.health} />
              </div>
            ) : (
              <div className="waiting-worker">
                <Clock3 size={17} />
                <span>
                  {current?.status === "queued"
                    ? `正在等待空闲工位${current.queuePosition ? ` · 队列第 ${current.queuePosition} 位` : ""}`
                    : "本轮尚未分配工位"}
                </span>
              </div>
            )}
            {current?.status === "failed" && (
              <div className="preserved-error">
                <AlertTriangle size={18} />
                <div>
                  <strong>现场已保留</strong>
                  <p>
                    {current.errorMessage ??
                      "执行未能安全完成。工位不会恢复检查点，也不会分配给其他任务。"}
                  </p>
                  <code>{current.errorCode}</code>
                </div>
              </div>
            )}
          </div>

          <div className="inspector-block delivery-block">
            <div className="inspector-title">
              <div>
                <span>代码交付</span>
                <h2>任务分支</h2>
              </div>
              <GitBranch size={18} />
            </div>
            <dl className="delivery-facts">
              <div>
                <dt>分支</dt>
                <dd>
                  <code>{task.branchName}</code>
                </dd>
              </div>
              <div>
                <dt>远程 SHA</dt>
                <dd>
                  <code>{compactSha(task.latestCommitSha)}</code>
                </dd>
              </div>
              <div>
                <dt>基础分支</dt>
                <dd>{task.baseBranch}</dd>
              </div>
              <div>
                <dt>Codex thread</dt>
                <dd>
                  <code>
                    {task.codexThreadId
                      ? task.codexThreadId.slice(0, 12) + "…"
                      : "待创建"}
                  </code>
                </dd>
              </div>
              <div>
                <dt>Codex 模型</dt>
                <dd>{codexModelLabel(task.codexModel)}</dd>
              </div>
              <div>
                <dt>思考深度</dt>
                <dd>{codexReasoningLabel(task.codexReasoningEffort)}</dd>
              </div>
              <div>
                <dt>Fast 模式</dt>
                <dd>{task.codexFastMode ? "已开启" : "普通速度"}</dd>
              </div>
            </dl>
            {current?.result && (
              <div className="change-summary">
                <span>
                  <FileCode2 size={15} />
                  {current.result.changedFiles?.length ?? 0} 个文件
                </span>
                <span className="additions">
                  +{current.result.diff?.additions ?? 0}
                </span>
                <span className="deletions">
                  −{current.result.diff?.deletions ?? 0}
                </span>
              </div>
            )}
          </div>

          <div className="inspector-block technical-log">
            <button
              className="log-toggle"
              onClick={() => setLogsOpen((value) => !value)}
            >
              <span>
                <TerminalSquare size={16} />
                技术日志
              </span>
              <span>
                {events.length} 条{" "}
                <ChevronDown className={logsOpen ? "rotated" : ""} size={15} />
              </span>
            </button>
            {logsOpen && (
              <EventStream
                events={events.slice(-40).reverse()}
                tasks={[task]}
              />
            )}
          </div>
        </aside>
      </div>
      {busy && (
        <div className="mutation-overlay">
          <LoaderCircle className="spin" size={18} />
          正在提交操作…
        </div>
      )}
    </div>
  );
}

function TurnConversation({
  turn,
  task,
  events,
}: {
  turn: Turn;
  task: Task;
  events: PipelineEvent[];
}) {
  const result = turn.result;
  const finalText =
    typeof turn.codexFinal === "string"
      ? turn.codexFinal
      : turn.codexFinal && typeof turn.codexFinal.summary === "string"
        ? turn.codexFinal.summary
        : null;
  const finalSummary = result?.summary ?? finalText;
  const progressByItem = new Map<
    string,
    { event: PipelineEvent; text: string }
  >();
  for (const event of events) {
    if (event.type !== "codex.agent_message") continue;
    const text = readableCodexMessage(event.message);
    if (!text || text === finalSummary?.trim()) continue;
    const itemId =
      typeof event.data?.itemId === "string"
        ? event.data.itemId
        : String(event.id);
    progressByItem.set(itemId, { event, text });
  }
  const progressMessages = [...progressByItem.values()].sort((a, b) =>
    compareEvents(a.event, b.event),
  );
  const latestStatusEvent = [...events]
    .reverse()
    .find((event) => event.type !== "codex.agent_message");
  return (
    <article className="turn-thread">
      <div className="timeline-node">
        <span>{turn.sequence}</span>
      </div>
      <div className="user-message">
        <div className="message-head">
          <span className="avatar small">L</span>
          <strong>你</strong>
          <time>{relativeTime(turn.createdAt)}</time>
          <StatusBadge status={turn.status} label={`第 ${turn.sequence} 轮`} />
        </div>
        <p>{turn.userMessage}</p>
      </div>
      {progressMessages.map(({ event, text }) => (
        <div
          className="codex-progress-message"
          key={event.id}
          aria-label="Codex 进度消息"
        >
          <div className="message-head">
            <span className="bot-avatar">
              <Bot size={16} />
            </span>
            <strong>Codex</strong>
            <span className="message-kind">进度</span>
            <time>{relativeTime(event.createdAt)}</time>
          </div>
          <p>{text}</p>
        </div>
      ))}
      {LIVE_TURN.has(turn.status) && (
        <div className="codex-running-message" role="status" aria-live="polite">
          <span className="bot-avatar">
            <Bot size={16} />
          </span>
          <div>
            <strong>
              {progressMessages.length
                ? "Codex 正在继续处理"
                : "Codex 正在处理"}
            </strong>
            <p>
              {latestStatusEvent?.message ??
                phaseLabel[turn.phase ?? ""] ??
                "等待下一步事件"}
            </p>
            <span className="stream-line">
              <i />
            </span>
          </div>
        </div>
      )}
      {finalSummary && (
        <div className="codex-message">
          <div className="message-head">
            <span className="bot-avatar">
              <Bot size={16} />
            </span>
            <strong>Codex</strong>
            <time>{relativeTime(turn.finishedAt)}</time>
          </div>
          <p>{finalSummary}</p>
          {result?.changedFiles && result.changedFiles.length > 0 && (
            <div className="changed-files">
              {result.changedFiles.slice(0, 6).map((file) => (
                <code key={file}>
                  <FileCode2 size={12} />
                  {file}
                </code>
              ))}
            </div>
          )}
          {result?.validation && result.validation.length > 0 && (
            <ul className="validation-list">
              {result.validation.map((item) => (
                <li key={item}>
                  <CheckCircle2 size={14} />
                  {item}
                </li>
              ))}
            </ul>
          )}
          {result?.risks && result.risks.length > 0 && (
            <div className="result-risks">
              <AlertTriangle size={15} />
              <div>
                <strong>仍需注意</strong>
                <ul>
                  {result.risks.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {result?.question && (
            <div className="result-question">
              <MessageSquareText size={15} />
              <div>
                <strong>Codex 需要你确认</strong>
                <p>{result.question}</p>
              </div>
            </div>
          )}
        </div>
      )}
      {turn.commitSha && (
        <div className="commit-anchor">
          <span className="commit-icon">
            <GitCommitHorizontal size={16} />
          </span>
          <div>
            <strong>第 {turn.sequence} 轮已保存</strong>
            <span>
              <code>{compactSha(turn.commitSha)}</code> · 已推送至{" "}
              {task.branchName}
            </span>
          </div>
          <CheckCircle2 size={17} />
        </div>
      )}
      {turn.status === "failed" && (
        <div className="turn-error">
          <AlertTriangle size={17} />
          <div>
            <strong>{turn.errorCode ?? "执行失败"}</strong>
            <p>{turn.errorMessage ?? "现场已保留，等待人工处理。"}</p>
          </div>
        </div>
      )}
    </article>
  );
}

function PhaseProgress({ turn }: { turn: Turn }) {
  const currentIndex =
    turn.status === "success"
      ? phaseSequence.length
      : Math.max(0, phaseSequence.indexOf(turn.phase ?? ""));
  const groups = [
    { label: "恢复", index: 1 },
    { label: "同步", index: 2 },
    { label: "Codex", index: 4 },
    { label: "Unity", index: 6 },
    { label: "推送", index: 8 },
  ];
  return (
    <div className="phase-progress">
      <div className="current-phase-copy">
        <span>
          {turn.status === "queued"
            ? "等待队列"
            : (phaseLabel[turn.phase ?? ""] ?? turnStatusLabel[turn.status])}
        </span>
        {turn.phase && <code>{turn.phase}</code>}
      </div>
      <div className="phase-track">
        {groups.map((group, index) => {
          const done = currentIndex > group.index || turn.status === "success";
          const active =
            currentIndex >= group.index &&
            currentIndex < (groups[index + 1]?.index ?? 99) &&
            !done;
          return (
            <div
              key={group.label}
              className={cx("phase-step", done && "done", active && "active")}
            >
              <span>
                {done ? (
                  <Check size={11} />
                ) : active ? (
                  <CircleDot size={11} />
                ) : (
                  <Circle size={9} />
                )}
              </span>
              <small>{group.label}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WorkersPage({
  snapshot,
  selected,
  onSelect,
  onAction,
  onCreate,
  onEdit,
}: {
  snapshot: Snapshot;
  selected: Worker | null;
  onSelect: (id: string | null) => void;
  onAction: (worker: Worker, action: string) => void;
  onCreate: () => void;
  onEdit: (worker: Worker) => void;
}) {
  const groups = [
    { label: "正在使用", statuses: ["busy"] },
    { label: "可用", statuses: ["ready"] },
    { label: "准备或保留", statuses: ["preparing", "restarting", "reserved"] },
    { label: "需要处理", statuses: ["attention", "offline"] },
    { label: "已关闭", statuses: ["stopped"] },
  ];
  return (
    <div className="page workers-page">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">WORKER POOL</span>
          <h1>虚拟机工位</h1>
          <p>
            工位只是可复用的执行资源。对话和代码通过 thread
            与远程分支独立持久化。
          </p>
        </div>
        <button className="primary-action" onClick={onCreate}>
          <Plus size={18} />
          添加工位
        </button>
      </section>
      <div className="worker-topology">
        <div className="topology-canvas">
          <div className="topology-spine">
            <span className="spine-head">
              <Network size={16} />
              Hyper-V 资源总线
            </span>
            <i />
          </div>
          {groups.map((group) => {
            const workers = snapshot.workers.filter((worker) =>
              group.statuses.includes(worker.status),
            );
            if (!workers.length) return null;
            return (
              <section className="worker-group" key={group.label}>
                <h2>
                  {group.label}
                  <span>{workers.length}</span>
                </h2>
                {workers.map((worker) => {
                  const turn = snapshot.turns.find(
                    (item) => item.id === worker.currentTurnId,
                  );
                  const task =
                    turn &&
                    snapshot.tasks.find((item) => item.id === turn.taskId);
                  return (
                    <button
                      key={worker.id}
                      className={cx(
                        "topology-worker",
                        selected?.id === worker.id && "selected",
                      )}
                      onClick={() => onSelect(worker.id)}
                    >
                      <span className="topology-connector" />
                      <span
                        className={cx(
                          "worker-orb large",
                          `worker-${worker.status}`,
                        )}
                      >
                        <Server size={18} />
                      </span>
                      <span className="topology-worker-copy">
                        <strong>{worker.name}</strong>
                        <small>{worker.vmName}</small>
                      </span>
                      <StatusBadge status={worker.status} />
                      <span className="topology-assignment">
                        {task ? (
                          <>
                            <strong>{task.number}</strong>
                            <small>第 {turn?.sequence} 轮</small>
                          </>
                        ) : (
                          <small>{worker.internalIp ?? "未配置内部 IP"}</small>
                        )}
                      </span>
                      <HealthStrip health={worker.health} detailed />
                      <ChevronRight size={17} />
                    </button>
                  );
                })}
              </section>
            );
          })}
          {snapshot.workers.length === 0 && (
            <EmptyState
              icon={Server}
              title="工位池还是空的"
              description="添加第一台真实 Hyper-V 虚拟机，并配置 PowerShell Direct 与 SMB。"
              action={
                <button className="primary-action" onClick={onCreate}>
                  <Plus size={16} />
                  添加 lin-worker-01
                </button>
              }
            />
          )}
        </div>
        <aside className={cx("worker-inspector", selected && "open")}>
          {selected ? (
            <WorkerInspector
              worker={selected}
              snapshot={snapshot}
              onAction={onAction}
              onEdit={onEdit}
              onClose={() => onSelect(null)}
            />
          ) : (
            <div className="worker-inspector-empty">
              <MonitorCog size={26} />
              <strong>选择一个工位</strong>
              <span>查看身份、健康检查和安全操作。</span>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function WorkerInspector({
  worker,
  snapshot,
  onAction,
  onEdit,
  onClose,
}: {
  worker: Worker;
  snapshot: Snapshot;
  onAction: (worker: Worker, action: string) => void;
  onEdit: (worker: Worker) => void;
  onClose: () => void;
}) {
  const turn = snapshot.turns.find((item) => item.id === worker.currentTurnId);
  const task = turn && snapshot.tasks.find((item) => item.id === turn.taskId);
  const healthLabels: Array<[keyof Worker["health"], string, typeof Activity]> =
    [
      ["vm", "虚拟机", Server],
      ["heartbeat", "Heartbeat", HeartPulse],
      ["smb", "SMB 共享", HardDrive],
      ["unity", "Unity 进程", Box],
      ["skill", "Unity Skill", Zap],
    ];
  return (
    <>
      <div className="inspector-panel-head">
        <div>
          <span>工位详情</span>
          <h2>{worker.name}</h2>
        </div>
        <IconButton label="关闭" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
      <div className="worker-identity-block">
        <span className={cx("worker-orb hero", `worker-${worker.status}`)}>
          <Server size={22} />
        </span>
        <div>
          <StatusBadge status={worker.status} />
          <p>{worker.vmName}</p>
        </div>
        <button className="text-action" onClick={() => onEdit(worker)}>
          <Settings size={14} />
          编辑
        </button>
      </div>
      <dl className="worker-facts">
        <div>
          <dt>内部 IP</dt>
          <dd>
            <code>{worker.internalIp ?? "—"}</code>
          </dd>
        </div>
        <div>
          <dt>公司 IP</dt>
          <dd>
            <code>{worker.corporateIp ?? "—"}</code>
          </dd>
        </div>
        <div>
          <dt>检查点</dt>
          <dd>
            {snapshot.server.runtime?.checkpointsEnabled
              ? (worker.checkpointName ?? "PROJECT_READY")
              : "暂未启用"}
          </dd>
        </div>
        <div>
          <dt>SMB</dt>
          <dd>
            <code>{worker.smbPath ?? "—"}</code>
          </dd>
        </div>
      </dl>
      <section className="worker-health-block">
        <h3>
          健康检查 <span>{relativeTime(worker.lastSeenAt)}</span>
        </h3>
        {healthLabels.map(([key, label, Icon]) => {
          const state = worker.health?.[key] ?? ("unknown" as HealthState);
          return (
            <div className="health-detail-row" key={key}>
              <Icon size={15} />
              <span>{label}</span>
              <strong className={`health-text-${state}`}>
                {state === "healthy"
                  ? "正常"
                  : state === "warning"
                    ? "警告"
                    : state === "error"
                      ? "异常"
                      : "未知"}
              </strong>
            </div>
          );
        })}
      </section>
      {task && (
        <section className="worker-current-task">
          <span>当前占用</span>
          <strong>
            {task.number} · {task.title}
          </strong>
          <p>
            第 {turn?.sequence} 轮 ·{" "}
            {phaseLabel[turn?.phase ?? ""] ??
              turnStatusLabel[turn?.status ?? ""]}
          </p>
          <code>{task.branchName}</code>
        </section>
      )}
      {worker.lastError && (
        <div className="preserved-error compact">
          <AlertTriangle size={17} />
          <div>
            <strong>需要人工处理</strong>
            <p>{worker.lastError}</p>
          </div>
        </div>
      )}
      <section className="worker-controls">
        <h3>安全操作</h3>
        <div className="control-grid">
          <button
            onClick={() => onAction(worker, "start")}
            disabled={worker.status !== "stopped"}
          >
            <Play size={15} />
            启动
          </button>
          <button
            onClick={() => onAction(worker, "shutdown")}
            disabled={worker.status === "stopped" || worker.status === "busy"}
          >
            <Power size={15} />
            正常关机
          </button>
          <button
            onClick={() => onAction(worker, "restart")}
            disabled={worker.status === "busy"}
          >
            <RefreshCw size={15} />
            重启
          </button>
          <button onClick={() => onAction(worker, "probe")}>
            <Activity size={15} />
            重新检查
          </button>
        </div>
      </section>
      <details className="danger-zone">
        <summary>
          <AlertTriangle size={15} />
          危险操作
        </summary>
        <p>仅在现场已经确认可丢弃或需要解除隔离时使用。</p>
        <button
          onClick={() => onAction(worker, "restore")}
          disabled={!snapshot.server.runtime?.checkpointsEnabled}
          title={
            snapshot.server.runtime?.checkpointsEnabled
              ? undefined
              : "检查点管理尚未启用"
          }
        >
          <RotateCcw size={15} />
          恢复检查点
        </button>
        <button onClick={() => onAction(worker, "forceOff")}>
          <OctagonX size={15} />
          强制关闭
        </button>
        {["attention", "reserved"].includes(worker.status) && (
          <button onClick={() => onAction(worker, "release")}>
            <CheckCircle2 size={15} />
            解除隔离
          </button>
        )}
      </details>
    </>
  );
}

function ProjectsPage({
  snapshot,
  onCreate,
  onEdit,
  onDelete,
}: {
  snapshot: Snapshot;
  onCreate: () => void;
  onEdit: (project: Project) => void;
  onDelete: (project: Project) => void;
}) {
  return (
    <div className="page projects-page">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">ENVIRONMENT CATALOG</span>
          <h1>项目环境</h1>
          <p>为每个仓库绑定来宾路径、SMB、Unity Skill、基线分支与兼容工位。</p>
        </div>
        <button className="primary-action" onClick={onCreate}>
          <Plus size={18} />
          添加项目
        </button>
      </section>
      <div className="project-ledger">
        <div className="project-ledger-head">
          <span>项目</span>
          <span>代码来源</span>
          <span>Unity 环境</span>
          <span>可用工位</span>
          <span>基线</span>
          <span />
        </div>
        {snapshot.projects.map((project) => {
          const compatible = snapshot.workers.filter(
            (worker) =>
              worker.projectIds?.includes(project.id) ||
              project.compatibleWorkerIds?.includes(worker.id),
          );
          return (
            <article className="project-row" key={project.id}>
              <div className="project-name-cell">
                <span className="project-symbol">
                  <FolderGit2 size={18} />
                </span>
                <div>
                  <strong>{project.name}</strong>
                  <small>{project.enabled ? "已启用" : "已停用"}</small>
                </div>
              </div>
              <div>
                <code className="truncate-code">{project.repoUrl}</code>
                <span className="cell-sub">
                  <GitBranch size={12} />
                  {project.defaultBranch}
                </span>
              </div>
              <div>
                <strong>{project.unityVersion || "未指定版本"}</strong>
                <span className="cell-sub">
                  <Zap size={12} />
                  Skill :{project.unitySkillPort}
                </span>
              </div>
              <div>
                <div className="worker-avatar-stack">
                  {compatible.slice(0, 4).map((worker) => (
                    <span key={worker.id} title={worker.name}>
                      {worker.name.split("-").at(-1)}
                    </span>
                  ))}
                  {!compatible.length && <small>未绑定</small>}
                </div>
              </div>
              <div>
                <strong>{project.checkpointName}</strong>
                <span className="cell-sub">
                  配置更新 {relativeTime(project.updatedAt)}
                </span>
              </div>
              <div className="row-actions">
                <IconButton label="编辑项目" onClick={() => onEdit(project)}>
                  <Settings size={16} />
                </IconButton>
                <IconButton label="删除项目" onClick={() => onDelete(project)}>
                  <Trash2 size={16} />
                </IconButton>
              </div>
            </article>
          );
        })}
        {snapshot.projects.length === 0 && (
          <EmptyState
            icon={FolderGit2}
            title="还没有项目环境"
            description="添加仓库与 Unity 环境后，任务才能匹配到兼容工位。"
            action={
              <button className="primary-action" onClick={onCreate}>
                <Plus size={16} />
                添加项目
              </button>
            }
          />
        )}
      </div>
      <div className="project-principle">
        <ShieldCheck size={20} />
        <div>
          <strong>环境基线不会被任务隐式更新</strong>
          <p>
            管理台不会自动覆盖 PROJECT_READY。请在维护窗口逐台更新并通过 canary
            后，再重新启用对应工位。
          </p>
        </div>
      </div>
    </div>
  );
}

function SettingsPage({
  snapshot,
  connected,
  onSaved,
  notify,
}: {
  snapshot: Snapshot;
  connected: boolean;
  onSaved: () => void;
  notify: (message: string, kind?: Toast["kind"]) => void;
}) {
  const [base, setBase] = useState(() => getApiBase());
  const [tokenValue, setTokenValue] = useState(() => getToken());
  const [changingScheduler, setChangingScheduler] = useState(false);
  const save = () => {
    setApiBase(base);
    setToken(tokenValue);
    notify("连接设置已保存");
    onSaved();
  };
  const enableNotifications = async () => {
    if (!("Notification" in window))
      return notify("当前浏览器不支持系统通知", "error");
    const result = await Notification.requestPermission();
    notify(
      result === "granted" ? "浏览器通知已启用" : "未获得浏览器通知权限",
      result === "granted" ? "success" : "error",
    );
  };
  const toggleScheduler = async () => {
    const shouldPause = snapshot.server.schedulerRunning !== false;
    setChangingScheduler(true);
    try {
      await api(`/api/scheduler/${shouldPause ? "pause" : "resume"}`, {
        method: "POST",
      });
      notify(
        shouldPause
          ? "调度器已暂停；排队轮次和正在执行的轮次都已保留"
          : "调度器已恢复领取排队轮次",
      );
      onSaved();
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "调度器操作失败",
        "error",
      );
    } finally {
      setChangingScheduler(false);
    }
  };
  return (
    <div className="page settings-page">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">SYSTEM CONTROL</span>
          <h1>系统设置</h1>
          <p>网页只管理结构化任务和白名单操作，不提供任意 PowerShell 入口。</p>
        </div>
        <StatusBadge
          status={connected ? "ready" : "offline"}
          label={connected ? "实时连接正常" : "服务已断开"}
        />
      </section>
      <div className="settings-layout">
        <section className="settings-main">
          <div className="settings-section">
            <div className="settings-section-title">
              <Network size={18} />
              <div>
                <h2>控制服务连接</h2>
                <p>远程浏览器默认连接当前主机名的 4317 端口。</p>
              </div>
            </div>
            <label className="form-field">
              <span>API 地址</span>
              <input
                value={base}
                onChange={(event) => setBase(event.target.value)}
                placeholder="http://10.100.3.175:4317"
              />
            </label>
            <label className="form-field">
              <span>管理令牌</span>
              <input
                type="password"
                value={tokenValue}
                onChange={(event) => setTokenValue(event.target.value)}
                placeholder="仅保存在当前标签页"
              />
              <small>令牌保存在 sessionStorage，关闭浏览器标签后即清除。</small>
            </label>
            <button className="primary-action" onClick={save}>
              <Save size={16} />
              保存并重新连接
            </button>
          </div>
          <div className="settings-section">
            <div className="settings-section-title">
              <Bell size={18} />
              <div>
                <h2>通知</h2>
                <p>任务轮次交付、失败和工位隔离时通知当前浏览器。</p>
              </div>
            </div>
            <button
              className="secondary-action"
              onClick={() => void enableNotifications()}
            >
              <Bell size={16} />
              启用浏览器通知
            </button>
          </div>
          <div className="settings-section">
            <div className="settings-section-title">
              <Database size={18} />
              <div>
                <h2>持久化边界</h2>
                <p>
                  SQLite 保存调度事实，Codex thread
                  保存模型上下文，远程分支保存代码。
                </p>
              </div>
            </div>
            <div className="persistence-map">
              <div>
                <Database size={17} />
                <strong>SQLite WAL</strong>
                <span>任务、轮次、租约、事件</span>
              </div>
              <ArrowRight size={15} />
              <div>
                <Bot size={17} />
                <strong>Codex thread</strong>
                <span>连续对话上下文</span>
              </div>
              <ArrowRight size={15} />
              <div>
                <GitBranch size={17} />
                <strong>远程 Git</strong>
                <span>已核验的代码 SHA</span>
              </div>
            </div>
          </div>
        </section>
        <aside className="settings-status">
          <span className="section-kicker">当前运行方式</span>
          <div className={cx("mode-orb", "live")}>
            <Cpu size={28} />
          </div>
          <h2>Hyper-V 真实适配器</h2>
          <p>会执行白名单 PowerShell、来宾 Git 与宿主机 Codex CLI。</p>
          <dl>
            <div>
              <dt>服务版本</dt>
              <dd>{snapshot.server.version ?? "development"}</dd>
            </div>
            <div>
              <dt>调度循环</dt>
              <dd>
                {snapshot.server.schedulerRunning === false
                  ? "已暂停"
                  : "运行中"}
              </dd>
            </div>
            <div>
              <dt>认证</dt>
              <dd>{snapshot.server.requiresAuth ? "已启用" : "开发模式"}</dd>
            </div>
            <div>
              <dt>Hyper-V 权限</dt>
              <dd>
                {snapshot.server.runtime?.hyperv.canManage
                  ? `可用 · ${snapshot.server.runtime.hyperv.vmCount} 台 VM`
                  : "不可用"}
              </dd>
            </div>
            <div>
              <dt>Codex CLI</dt>
              <dd>
                {snapshot.server.runtime?.codex.authenticated
                  ? snapshot.server.runtime.codex.version
                  : "未登录或不可用"}
              </dd>
            </div>
            <div>
              <dt>检查点</dt>
              <dd>
                {snapshot.server.runtime?.checkpointsEnabled
                  ? "已启用"
                  : "暂未启用"}
              </dd>
            </div>
            <div>
              <dt>API</dt>
              <dd>
                <code>{getApiBase()}</code>
              </dd>
            </div>
          </dl>
          <button
            className="secondary-action scheduler-toggle"
            onClick={() => void toggleScheduler()}
            disabled={changingScheduler}
          >
            {changingScheduler ? (
              <LoaderCircle className="spin" size={16} />
            ) : snapshot.server.schedulerRunning === false ? (
              <Play size={16} />
            ) : (
              <Square size={15} />
            )}
            {snapshot.server.schedulerRunning === false
              ? "恢复调度"
              : "暂停领取新轮次"}
          </button>
          <small className="scheduler-toggle-note">
            暂停只阻止领取新的排队轮次，不中断正在执行的工作。
          </small>
          <div className="safety-note">
            <ShieldCheck size={17} />
            <span>
              生产路径只使用真实 Hyper-V 与 Codex
              CLI；检查点恢复可在准备完成后单独启用。
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ImageAttachmentPreview({ file }: { file: File }) {
  const [preview] = useState(() => URL.createObjectURL(file));

  useEffect(() => () => URL.revokeObjectURL(preview), [preview]);

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={preview} alt="" />;
}

function AttachmentChip({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  return (
    <div className="attachment-chip">
      {file.type.startsWith("image/") ? (
        <ImageAttachmentPreview file={file} />
      ) : (
        <span className="attachment-file-icon">
          <FileCode2 size={18} />
        </span>
      )}
      <span className="attachment-chip-copy">
        <strong>{file.name}</strong>
        <small>{formatFileSize(file.size)}</small>
      </span>
      <IconButton label={`移除 ${file.name}`} type="button" onClick={onRemove}>
        <X size={15} />
      </IconButton>
    </div>
  );
}

function CreateTaskModal({
  projects,
  workers,
  turns,
  busy,
  onClose,
  onSubmit,
}: {
  projects: Project[];
  workers: Worker[];
  turns: Turn[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>, files: File[]) => Promise<void>;
}) {
  const dialogRef = useDialogFocusTrap(onClose);
  const [idempotencyKey] = useState(createIdempotencyKey);
  const [requirement, setRequirement] = useState("");
  const [priority, setPriority] = useState(0);
  const [autoRelease, setAutoRelease] = useState(true);
  const [codexModel, setCodexModel] = useState("gpt-5.6-sol");
  const [codexReasoningEffort, setCodexReasoningEffort] = useState("xhigh");
  const [codexFastMode, setCodexFastMode] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const project = projects[0];
  const selectedCodexModel =
    CODEX_MODEL_OPTIONS.find((option) => option.value === codexModel) ??
    CODEX_MODEL_OPTIONS[0];
  const availableReasoningOptions = CODEX_REASONING_OPTIONS.filter((option) =>
    selectedCodexModel.efforts.some((effort) => effort === option.value),
  );

  const addFiles = (incoming: File[]) => {
    setFiles((current) => {
      const known = new Set(
        current.map(
          (file) =>
            `${file.name}:${file.size}:${file.lastModified}:${file.type}`,
        ),
      );
      return [
        ...current,
        ...incoming.filter((file) => {
          const key = `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
          if (known.has(key)) return false;
          known.add(key);
          return true;
        }),
      ];
    });
  };

  const pasteImages = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const timestamp = Date.now();
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
      .map((file, index) => {
        const extension =
          file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
        return new File(
          [file],
          `粘贴图片-${timestamp}-${index + 1}.${extension}`,
          { type: file.type, lastModified: timestamp + index },
        );
      });
    if (images.length) addFiles(images);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!project || !requirement.trim()) return;
    void onSubmit(
      {
        projectId: project.id,
        title: taskTitleFromContent(requirement),
        requirement: requirement.trim(),
        baseBranch: project.defaultBranch,
        priority,
        autoRelease,
        codexModel,
        codexReasoningEffort,
        codexFastMode,
        idempotencyKey,
      },
      files,
    );
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        ref={dialogRef}
        className="modal task-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
        aria-describedby="new-task-description"
        onSubmit={submit}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">NEW PERSISTENT TASK</span>
            <h2 id="new-task-title">发起新任务</h2>
            <p id="new-task-description">
              系统会创建专属分支、Codex 对话和第一个执行轮次。
            </p>
          </div>
          <IconButton label="关闭" type="button" onClick={onClose}>
            <X size={19} />
          </IconButton>
        </div>
        {projects.length ? (
          <>
            <label className="form-field requirement-field">
              <span>
                任务内容
                <small>可以直接 Ctrl+V 粘贴截图</small>
              </span>
              <textarea
                autoFocus
                value={requirement}
                onChange={(event) => setRequirement(event.target.value)}
                onPaste={pasteImages}
                placeholder="直接描述需要完成的内容、复现步骤和验收标准；截图可以直接粘贴到这里…"
                rows={9}
              />
            </label>
            <div className="attachment-actions">
              <label className="attachment-button">
                <Paperclip size={17} />
                添加图片或文件
                <input
                  type="file"
                  multiple
                  onChange={(event) => {
                    addFiles(Array.from(event.target.files ?? []));
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              <span>支持图片、文本和日志；也可以在上方直接粘贴截图</span>
            </div>
            {files.length > 0 && (
              <div className="attachment-list" aria-label="已添加的文件">
                {files.map((file, index) => (
                  <AttachmentChip
                    key={`${file.name}:${file.size}:${file.lastModified}:${index}`}
                    file={file}
                    onRemove={() =>
                      setFiles((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  />
                ))}
              </div>
            )}
            <section
              className="codex-task-settings"
              aria-labelledby="codex-task-settings-title"
            >
              <div className="codex-task-settings-head">
                <span className="codex-settings-icon">
                  <Bot size={18} />
                </span>
                <div>
                  <h3 id="codex-task-settings-title">Codex 配置</h3>
                  <p>该任务后续追加轮次会继续使用这里的选择。</p>
                </div>
              </div>
              <div className="codex-task-settings-grid">
                <StyledSelect
                  label="模型"
                  value={codexModel}
                  options={CODEX_MODEL_OPTIONS}
                  description={selectedCodexModel.detail}
                  onChange={(nextModel) => {
                    const nextOption = CODEX_MODEL_OPTIONS.find(
                      (option) => option.value === nextModel,
                    );
                    setCodexModel(nextModel);
                    if (
                      nextOption &&
                      !nextOption.efforts.some(
                        (effort) => effort === codexReasoningEffort,
                      )
                    ) {
                      setCodexReasoningEffort(
                        nextOption.efforts.includes("xhigh")
                          ? "xhigh"
                          : (nextOption.efforts.at(-1) ?? "high"),
                      );
                    }
                  }}
                />
                <StyledSelect
                  label="思考深度"
                  value={codexReasoningEffort}
                  options={availableReasoningOptions}
                  description="Extra High 对应 Codex 的 xhigh"
                  onChange={setCodexReasoningEffort}
                />
                <label className="task-release-toggle codex-fast-toggle">
                  <input
                    type="checkbox"
                    checked={codexFastMode}
                    onChange={(event) => setCodexFastMode(event.target.checked)}
                  />
                  <span>
                    <strong>
                      <Zap size={15} />
                      Fast 模式
                    </strong>
                    <small>
                      {codexFastMode
                        ? "已开启优先速度模式"
                        : "默认关闭，使用普通速度"}
                    </small>
                  </span>
                </label>
              </div>
            </section>
            <fieldset className="priority-fieldset">
              <legend>预计开始</legend>
              <p>选择调度等级；时间会根据当前工位和队列动态估算。</p>
              <div className="priority-options">
                {TASK_PRIORITY_OPTIONS.map((option) => {
                  const estimate = estimateTaskStart({
                    priority: option.value,
                    project,
                    workers,
                    turns,
                  });
                  return (
                    <label
                      key={option.value}
                      className={cx(
                        "priority-option",
                        priority === option.value && "selected",
                      )}
                    >
                      <input
                        type="radio"
                        name="priority"
                        value={option.value}
                        checked={priority === option.value}
                        onChange={() => setPriority(option.value)}
                      />
                      <span className="priority-card">
                        <span className="priority-copy">
                          <strong>{option.label}</strong>
                          <small>{option.detail}</small>
                        </span>
                        <span className="priority-estimate">
                          <Clock3 size={15} />
                          <strong>{estimate}</strong>
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <label className="task-release-toggle">
              <input
                type="checkbox"
                checked={autoRelease}
                onChange={(event) => setAutoRelease(event.target.checked)}
              />
              <span>
                <strong>交付成功后自动释放工位</strong>
                <small>关闭后会保留工位，方便继续人工检查</small>
              </span>
            </label>
            <div className="modal-actions">
              <span>
                <ShieldCheck size={14} />
                需求文本不会进入 PowerShell 命令
              </span>
              <button
                type="button"
                className="secondary-action"
                onClick={onClose}
              >
                取消
              </button>
              <button
                className="primary-action"
                disabled={busy || !requirement.trim()}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <ArrowRight size={17} />
                )}
                加入执行队列
              </button>
            </div>
          </>
        ) : (
          <EmptyState
            icon={FolderGit2}
            title="请先添加项目环境"
            description="至少需要一个已启用项目，才能创建任务。"
          />
        )}
      </form>
    </div>
  );
}

function ProjectEditor({
  project,
  workers,
  busy,
  onClose,
  onSave,
}: {
  project: Project | null;
  workers: Worker[];
  busy: boolean;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const dialogRef = useDialogFocusTrap(onClose);
  const [form, setForm] = useState({
    name: project?.name ?? "",
    repoUrl: project?.repoUrl ?? "",
    defaultBranch: project?.defaultBranch ?? "main",
    guestProjectPath: project?.guestProjectPath ?? "D:\\Work\\Project",
    smbPath: project?.smbPath ?? "\\\\172.30.240.11\\Work\\Project",
    unityVersion: project?.unityVersion ?? "2022.3",
    unitySkillUrl: project?.unitySkillUrl ?? "http://{internalIp}:8090/mcp",
    unityHealthUrl:
      project?.unityHealthUrl ?? "http://{internalIp}:8090/health",
    unitySaveUrl: project?.unitySaveUrl ?? "http://{internalIp}:8090/api/save",
    checkpointName: project?.checkpointName ?? "PROJECT_READY",
    enabled: project?.enabled ?? true,
  });
  const set = (key: string, value: unknown) =>
    setForm((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSave(form);
  };
  return (
    <div className="modal-backdrop">
      <form
        ref={dialogRef}
        className="modal editor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-editor-title"
        aria-describedby="project-editor-description"
        onSubmit={submit}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">PROJECT ENVIRONMENT</span>
            <h2 id="project-editor-title">
              {project ? "编辑项目" : "添加项目"}
            </h2>
            <p id="project-editor-description">
              这里保存引用，不保存 Git、SMB 或 Windows 明文密码。
            </p>
          </div>
          <IconButton label="关闭" type="button" onClick={onClose}>
            <X size={19} />
          </IconButton>
        </div>
        <div className="editor-grid">
          <label className="form-field">
            <span>项目名称</span>
            <input
              required
              value={form.name}
              onChange={(event) => set("name", event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>默认分支</span>
            <input
              required
              value={form.defaultBranch}
              onChange={(event) => set("defaultBranch", event.target.value)}
            />
          </label>
          <label className="form-field wide">
            <span>Git 仓库地址</span>
            <input
              required
              value={form.repoUrl}
              onChange={(event) => set("repoUrl", event.target.value)}
              placeholder="git@github.com:company/project.git"
            />
          </label>
          <label className="form-field">
            <span>子机项目路径</span>
            <input
              required
              value={form.guestProjectPath}
              onChange={(event) => set("guestProjectPath", event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>宿主机 SMB 路径（兼容回退）</span>
            <input
              required
              value={form.smbPath}
              onChange={(event) => set("smbPath", event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>Unity 版本</span>
            <input
              value={form.unityVersion}
              onChange={(event) => set("unityVersion", event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>基线检查点</span>
            <input
              required
              value={form.checkpointName}
              onChange={(event) => set("checkpointName", event.target.value)}
            />
          </label>
          <label className="form-field wide">
            <span>Unity Skill MCP URL</span>
            <input
              value={form.unitySkillUrl}
              onChange={(event) => set("unitySkillUrl", event.target.value)}
              placeholder="http://{internalIp}:8090/mcp"
            />
            <small>
              Codex 连接此 MCP 端点。支持 {"{internalIp}"}、{"{corporateIp}"}、
              {"{workerName}"} 占位符。
            </small>
          </label>
          <label className="form-field">
            <span>Unity Skill 探活 URL</span>
            <input
              value={form.unityHealthUrl}
              onChange={(event) => set("unityHealthUrl", event.target.value)}
              placeholder="http://{internalIp}:8090/health"
            />
          </label>
          <label className="form-field">
            <span>Unity 保存 URL</span>
            <input
              value={form.unitySaveUrl}
              onChange={(event) => set("unitySaveUrl", event.target.value)}
              placeholder="http://{internalIp}:8090/api/save"
            />
          </label>
          <div className="binding-note wide">
            <Server size={15} />
            <span>
              项目与工位的兼容关系在“工位配置”中绑定。当前已有{" "}
              {
                workers.filter((worker) => worker.projectId === project?.id)
                  .length
              }{" "}
              台工位绑定此项目。
            </span>
          </div>
          <label className="toggle-row wide">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => set("enabled", event.target.checked)}
            />
            <span>
              <strong>允许新任务使用此项目</strong>
              <small>关闭后不影响现有任务历史</small>
            </span>
          </label>
        </div>
        <div className="modal-actions">
          <span />
          <button type="button" className="secondary-action" onClick={onClose}>
            取消
          </button>
          <button className="primary-action" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Save size={16} />
            )}
            保存项目
          </button>
        </div>
      </form>
    </div>
  );
}

function WorkerEditor({
  worker,
  projects,
  virtualMachines,
  busy,
  onClose,
  onSave,
}: {
  worker: Worker | null;
  projects: Project[];
  virtualMachines: HostVirtualMachine[];
  busy: boolean;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const dialogRef = useDialogFocusTrap(onClose);
  const discoveredVm = virtualMachines.find(
    (virtualMachine) => !worker || virtualMachine.name === worker.vmName,
  );
  const [form, setForm] = useState({
    name: worker?.name ?? discoveredVm?.name ?? "",
    vmName: worker?.vmName ?? discoveredVm?.name ?? "",
    internalIp:
      worker?.internalIp ??
      discoveredVm?.ipAddresses?.find((address) => address.includes(".")) ??
      "",
    corporateIp: worker?.corporateIp ?? "",
    sharePath:
      worker?.sharePath ?? worker?.smbPath ?? projects[0]?.smbPath ?? "",
    checkpointName: worker?.checkpointName ?? "PROJECT_READY",
    credentialPath: worker?.credentialPath ?? "",
    enabled: worker?.enabled ?? true,
    projectId: worker?.projectId ?? projects[0]?.id ?? "",
  });
  const set = (key: string, value: unknown) =>
    setForm((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSave(form);
  };
  return (
    <div className="modal-backdrop">
      <form
        ref={dialogRef}
        className="modal editor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="worker-editor-title"
        aria-describedby="worker-editor-description"
        onSubmit={submit}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">HYPER-V WORKER</span>
            <h2 id="worker-editor-title">{worker ? "编辑工位" : "添加工位"}</h2>
            <p id="worker-editor-description">
              虚拟机名必须与 Hyper-V 中的真实对象精确匹配；检查点可稍后启用。
            </p>
          </div>
          <IconButton label="关闭" type="button" onClick={onClose}>
            <X size={19} />
          </IconButton>
        </div>
        <div className="editor-grid">
          <label className="form-field">
            <span>显示名称</span>
            <input
              required
              value={form.name}
              onChange={(event) => set("name", event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>Hyper-V VM 名称</span>
            <input
              required
              list="hyperv-vm-options"
              value={form.vmName}
              onChange={(event) => set("vmName", event.target.value)}
            />
            <datalist id="hyperv-vm-options">
              {virtualMachines.map((virtualMachine) => (
                <option
                  key={virtualMachine.id}
                  value={virtualMachine.name}
                  label={`${virtualMachine.state} · ${virtualMachine.status}`}
                />
              ))}
            </datalist>
            <small>
              {virtualMachines.length
                ? `已从当前宿主机发现 ${virtualMachines.length} 台虚拟机。`
                : "尚未读取到 VM 清单，请先检查系统页中的 Hyper-V 权限。"}
            </small>
          </label>
          <label className="form-field">
            <span>内部 IP</span>
            <input
              value={form.internalIp}
              onChange={(event) => set("internalIp", event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>公司 IP（可选）</span>
            <input
              value={form.corporateIp}
              onChange={(event) => set("corporateIp", event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>SMB 根路径</span>
            <input
              required
              value={form.sharePath}
              onChange={(event) => set("sharePath", event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>基线检查点</span>
            <input
              required
              value={form.checkpointName}
              onChange={(event) => set("checkpointName", event.target.value)}
            />
          </label>
          <label className="form-field wide">
            <span>绑定项目</span>
            <select
              required
              value={form.projectId}
              onChange={(event) => set("projectId", event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <small>
              第一版每台工位绑定一个项目；同一项目可绑定多台工位形成并发池。
            </small>
          </label>
          <label className="form-field wide">
            <span>DPAPI 凭据文件引用</span>
            <input
              value={form.credentialPath}
              onChange={(event) => set("credentialPath", event.target.value)}
              placeholder="C:\\ProgramData\\Relay\\secrets\\lin-worker-01.xml"
            />
            <small>
              数据库只存路径；凭据文件必须由运行服务的同一 Windows 账户创建。
            </small>
          </label>
          <label className="toggle-row wide">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => set("enabled", event.target.checked)}
            />
            <span>
              <strong>允许调度器分配这台工位</strong>
              <small>关闭会 drain 工位，不会终止正在运行的轮次</small>
            </span>
          </label>
        </div>
        <div className="modal-actions">
          <span />
          <button type="button" className="secondary-action" onClick={onClose}>
            取消
          </button>
          <button className="primary-action" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Save size={16} />
            )}
            保存工位
          </button>
        </div>
      </form>
    </div>
  );
}

function ConfirmDialog({
  state,
  busy,
  onClose,
}: {
  state: ConfirmState;
  busy: boolean;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocusTrap(onClose);
  const [text, setText] = useState("");
  const allowed = !state.requireText || text === state.requireText;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!allowed) return;
    await state.action();
    onClose();
  };
  return (
    <div className="modal-backdrop">
      <form
        ref={dialogRef}
        className="modal confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-description"
        onSubmit={submit}
      >
        <span className={cx("confirm-icon", state.danger && "danger")}>
          {state.danger ? (
            <AlertTriangle size={22} />
          ) : (
            <ShieldCheck size={22} />
          )}
        </span>
        <h2 id="confirm-title">{state.title}</h2>
        <p id="confirm-description">{state.description}</p>
        {state.requireText && (
          <label className="form-field">
            <span>
              输入 <code>{state.requireText}</code> 以确认
            </span>
            <input
              autoFocus
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
        )}
        <div className="modal-actions">
          <span />
          <button type="button" className="secondary-action" onClick={onClose}>
            返回
          </button>
          <button
            className={cx("primary-action", state.danger && "danger-action")}
            disabled={busy || !allowed}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : null}
            {state.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
