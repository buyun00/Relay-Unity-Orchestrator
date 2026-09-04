"use client";

import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  Bot,
  Box,
  Check,
  CheckCheck,
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
  Eraser,
  ExternalLink,
  FileCode2,
  FileText,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  HardDrive,
  HeartPulse,
  History,
  ImagePlus,
  Inbox,
  Layers3,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  Menu,
  MemoryStick,
  MessageSquareText,
  MessageSquarePlus,
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
  ScanLine,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Square,
  TerminalSquare,
  Thermometer,
  Trash2,
  Wifi,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  api,
  fetchHostMetrics,
  fetchSnapshot,
  fetchTaskEvents,
  getApiBase,
  getUserName,
  setApiBase,
  setUserName,
  subscribeEvents,
  uploadFile,
} from "./api";
import {
  EMPTY_SNAPSHOT,
  type Attachment,
  type BuildDispatch,
  type ExecutionProfile,
  type HealthState,
  type HostMetricsSnapshot,
  type HostVirtualMachine,
  type OpsThread,
  type OpsTurn,
  type PipelineEvent,
  type Project,
  type ProjectManagementDefect,
  type ProjectManagementProject,
  type ProjectManagementSession,
  type Snapshot,
  type Task,
  type Turn,
  type Worker,
} from "./types";

type ViewName = "dashboard" | "tasks" | "system" | "task";
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
type ProjectManagementDraft = {
  extraPrompt: string;
  files: File[];
};
type ProjectManagementBatchItem = ProjectManagementDraft & {
  defectId: string;
};
type ProjectManagementImportResult = {
  ok: boolean;
  created: number;
  duplicates: number;
  failed: number;
  results: Array<{
    defectId: string;
    status: "created" | "duplicate" | "failed";
    task?: Task;
    error?: { code?: string; message?: string };
  }>;
};

const PROJECT_MANAGEMENT_IMPORT_CHUNK_SIZE = 30;

const LIVE_TURN = new Set([
  "queued",
  "preparing",
  "running",
  "saving",
  "cancel_requested",
]);
const EXECUTING_TURN = new Set([
  "preparing",
  "running",
  "saving",
  "cancel_requested",
]);
const LIVE_TASK = new Set(["queued", "running"]);

const TASK_PRIORITY_OPTIONS = [
  { value: 100, label: "紧急", detail: "优先于其他等级" },
  { value: 10, label: "较高", detail: "优先于普通任务" },
  { value: 0, label: "普通", detail: "按当前队列顺序" },
] as const;

const EXECUTION_PROFILE_OPTIONS = [
  {
    value: "auto",
    label: "自动判断（代码优先）",
    detail: "默认不碰 Unity；只有确认必须操作序列化资产时才升级",
  },
  {
    value: "code_only",
    label: "仅代码",
    detail: "禁止探测、等待或修复 Unity 与 UnitySkills",
  },
  {
    value: "unity_asset",
    label: "Unity 资源 / Prefab",
    detail: "明确需要读取或修改真实 Prefab、Scene、组件或序列化绑定",
  },
] as const;

function executionProfileLabel(value?: ExecutionProfile) {
  return (
    EXECUTION_PROFILE_OPTIONS.find(
      (option) => option.value === (value ?? "auto"),
    )?.label ?? "自动判断（代码优先）"
  );
}

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
  disabled = false,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string; detail?: string }>;
  onChange: (value: string) => void;
  description?: string;
  disabled?: boolean;
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
          disabled={disabled}
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
  recovering: "自动恢复中",
  waiting_user: "等待你确认",
  waiting_review: "等待审阅",
  needs_attention: "需要处理",
  closed: "已完成",
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

const buildStageSequence = [
  ["queued", "排队"],
  ["preparing", "准备"],
  ["building", "构建"],
  ["validating", "校验"],
  ["publishing", "发布"],
  ["completed", "可查看"],
] as const;

const workerStatusLabel: Record<string, string> = {
  ready: "空闲",
  busy: "使用中",
  preparing: "准备中",
  reserved: "已保留",
  offline: "离线",
  stopped: "已关闭",
  restarting: "重启中",
};

const opsStatusLabel: Record<string, string> = {
  idle: "待命",
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  monitoring: "持续观察",
  action_required: "需要修复",
  open: "待处理",
  acting: "修复中",
  resolved: "已解决",
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
  unity_prepare: "等待 Unity",
  unity: "等待 Unity",
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
  { view: "system", label: "系统", icon: Settings },
];

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function userInitial(name?: string | null) {
  return name?.trim().charAt(0).toLocaleUpperCase() || "?";
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

function taskBuildDispatches(snapshot: Snapshot, taskId: string) {
  return snapshot.buildDispatches
    .filter((dispatch) => dispatch.taskId === taskId)
    .sort(
      (a, b) =>
        b.turnSequence - a.turnSequence ||
        b.createdAt.localeCompare(a.createdAt),
    );
}

function buildStatusView(dispatch: BuildDispatch) {
  if (dispatch.status === "pending") {
    return {
      key: "pending",
      label: "等待拉起打包",
      detail: "交付已经完成，后台即将联系打包机。",
      tone: "running",
      stageIndex: -1,
    };
  }
  if (dispatch.status === "sending") {
    return {
      key: "sending",
      label: "正在拉起打包机",
      detail: "任务已经完成；这里只等待打包机接单。",
      tone: "running",
      stageIndex: -1,
    };
  }
  if (dispatch.status === "retrying") {
    return {
      key: "retrying",
      label: "拉起失败，自动重试",
      detail:
        dispatch.lastErrorMessage ?? "打包机暂不可用，后台会使用同一请求重试。",
      tone: "warning",
      stageIndex: -1,
    };
  }
  if (dispatch.status === "failed") {
    return {
      key: "dispatch-failed",
      label: "未能拉起打包",
      detail: dispatch.lastErrorMessage ?? "打包请求未被打包机接受。",
      tone: "error",
      stageIndex: -1,
    };
  }

  const status = dispatch.buildStatus || "queued";
  const stageIndex = buildStageSequence.findIndex(([key]) => key === status);
  const labels: Record<string, string> = {
    queued: "已进入打包队列",
    preparing: "正在准备打包",
    building: "正在构建热更",
    validating: "正在校验产物",
    publishing: "正在发布热更",
    completed: "打包成功",
    failed: "热更打包失败",
    unknown: "打包机已接单",
  };
  return {
    key: status,
    label: labels[status] ?? `打包状态：${status}`,
    detail:
      dispatch.buildErrorMessage ??
      dispatch.buildStep ??
      (dispatch.statusCheckErrorMessage
        ? `${dispatch.statusCheckErrorMessage}，后台会继续刷新。`
        : "打包独立运行，不占用任务工位。"),
    tone:
      status === "completed"
        ? "success"
        : status === "failed"
          ? "error"
          : dispatch.statusCheckErrorCode
            ? "warning"
            : "running",
    stageIndex,
  };
}

function BuildStatusPill({ dispatch }: { dispatch: BuildDispatch }) {
  const view = buildStatusView(dispatch);
  return (
    <span className={cx("build-status-pill", `build-tone-${view.tone}`)}>
      {view.tone === "success" ? (
        <CheckCircle2 size={13} />
      ) : view.tone === "error" ? (
        <AlertTriangle size={13} />
      ) : (
        <LoaderCircle
          className={view.tone === "running" ? "spin" : ""}
          size={13}
        />
      )}
      热更：{view.label}
    </span>
  );
}

function BuildProgressCard({ dispatch }: { dispatch: BuildDispatch }) {
  const view = buildStatusView(dispatch);
  const completedStages = Math.max(0, view.stageIndex + 1);
  const progress =
    view.key === "failed" || view.key === "dispatch-failed"
      ? 0
      : view.stageIndex < 0
        ? 8
        : ((view.stageIndex + 1) / buildStageSequence.length) * 100;
  const progressLabel =
    view.key === "completed"
      ? "已完成"
      : view.stageIndex < 0
        ? "等待打包机接单"
        : `第 ${completedStages}/${buildStageSequence.length} 阶段`;
  return (
    <article className={cx("build-progress-card", `build-tone-${view.tone}`)}>
      <div className="build-progress-head">
        <div className="build-progress-icon">
          {view.tone === "success" ? (
            <CheckCircle2 size={20} />
          ) : view.tone === "error" ? (
            <AlertTriangle size={20} />
          ) : (
            <Box size={20} />
          )}
        </div>
        <div>
          <span>第 {dispatch.turnSequence} 轮 · Windows CDN</span>
          <h3>{view.label}</h3>
        </div>
        <code>{compactSha(dispatch.commitSha)}</code>
      </div>
      <div className="build-progress-summary">
        <span>打包进度</span>
        <strong>
          {Math.round(progress)}% <em>{progressLabel}</em>
        </strong>
      </div>
      <div
        className="build-progress-track"
        role="progressbar"
        aria-label={`第 ${dispatch.turnSequence} 轮热更打包进度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
        aria-valuetext={`${progressLabel}，${Math.round(progress)}%`}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="build-stage-list" aria-hidden="true">
        {buildStageSequence.map(([key, label], index) => (
          <span
            className={cx(
              index <= view.stageIndex && "reached",
              key === view.key && "current",
            )}
            key={key}
          >
            <i />
            {label}
          </span>
        ))}
      </div>
      <p className="build-progress-detail">{view.detail}</p>
      <div className="build-progress-meta">
        <span>Job：{dispatch.ozdqpJobId ?? "等待接单"}</span>
        <span>
          {dispatch.buildFinishedAt
            ? `完成于 ${relativeTime(dispatch.buildFinishedAt)}`
            : dispatch.statusCheckedAt
              ? `更新于 ${relativeTime(dispatch.statusCheckedAt)}`
              : `创建于 ${relativeTime(dispatch.createdAt)}`}
        </span>
        {dispatch.buildDurationSeconds != null && (
          <span>
            耗时 {Math.max(1, Math.round(dispatch.buildDurationSeconds / 60))}{" "}
            分钟
          </span>
        )}
        {dispatch.buildCdnUrl && view.key === "completed" && (
          <a href={dispatch.buildCdnUrl} target="_blank" rel="noreferrer">
            打开热更地址 <ArrowRight size={13} />
          </a>
        )}
      </div>
    </article>
  );
}

function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <span className={cx("status-badge", `status-${status}`)}>
      <span className="status-dot" aria-hidden="true" />
      {label ??
        taskStatusLabel[status] ??
        turnStatusLabel[status] ??
        workerStatusLabel[status] ??
        opsStatusLabel[status] ??
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
  const [connectionChecked, setConnectionChecked] = useState(false);
  const [lastConnectedAt, setLastConnectedAt] = useState<string | null>(null);
  const [userName, setCurrentUserName] = useState("");
  const [identityReady, setIdentityReady] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
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
  const refreshInFlight = useRef(false);

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
      if (refreshInFlight.current) return;
      refreshInFlight.current = true;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const next = await fetchSnapshot(controller.signal);
        setSnapshot({ ...next, server: { ...next.server, connected: true } });
        setConnected(true);
        setLastConnectedAt(new Date().toISOString());
        const newestEvent = next.events.at(-1);
        if (newestEvent) {
          if (
            lastNotifiedEvent.current !== null &&
            lastNotifiedEvent.current !== newestEvent.id &&
            typeof Notification !== "undefined" &&
            Notification.permission === "granted" &&
            (newestEvent.level === "error" ||
              /delivered|failed|unhealthy/.test(newestEvent.type))
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
        if (!silent) {
          notify(
            error instanceof Error
              ? error.name === "AbortError"
                ? "连接调度服务超时"
                : error.message
              : "无法连接调度服务",
            "error",
          );
        }
      } finally {
        window.clearTimeout(timeout);
        refreshInFlight.current = false;
        setConnectionChecked(true);
      }
    },
    [notify],
  );

  useEffect(() => {
    const initializeIdentity = window.setTimeout(() => {
      const storedUserName = getUserName();
      setCurrentUserName(storedUserName);
      setIdentityOpen(!storedUserName);
      setIdentityReady(true);
    }, 0);
    return () => window.clearTimeout(initializeIdentity);
  }, []);

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
      const requestedView = params.get("view");
      const taskId = params.get("task");
      if (requestedView === "ops") {
        setView("dashboard");
        window.history.replaceState({}, "", "?view=dashboard");
        return;
      }
      if (
        requestedView &&
        ["workers", "projects", "settings"].includes(requestedView)
      ) {
        setView("system");
        window.history.replaceState(
          {},
          "",
          `?view=system#system-${requestedView}`,
        );
        return;
      }
      const nextView = requestedView as ViewName | null;
      if (
        nextView &&
        ["dashboard", "tasks", "system", "task"].includes(nextView)
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
    if (view !== "system" || !window.location.hash) return;
    const sectionId = window.location.hash.slice(1);
    const timer = window.setTimeout(
      () =>
        document
          .getElementById(sectionId)
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      50,
    );
    return () => window.clearTimeout(timer);
  }, [view]);

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

  const requestTaskCompletion = (task: Task) => {
    const linkedDefect = task.projectManagement?.defectId;
    const retrying = task.completion?.status === "failed";
    setConfirm({
      title: retrying ? "重试确认完成" : "确认完成并自动合并",
      description: linkedDefect
        ? `将严格按顺序执行：先创建或复用 MR 并合并到主分支；确认合并成功后，把绑定的轻语缺陷 ${linkedDefect} 设为“已解决”；最后才把 Relay 任务标记为已完成。任一步失败都会立即停止，后续步骤不会执行。`
        : "将严格按顺序执行：先创建或复用 MR 并合并到主分支；确认合并成功后，才把 Relay 任务标记为已完成。任一步失败都会立即停止。",
      confirmLabel: retrying ? "重试完成" : "确认完成",
      action: () =>
        runMutation(
          () =>
            api(`/api/tasks/${task.id}/close`, {
              method: "POST",
            }),
          linkedDefect
            ? "MR、轻语缺陷和 Relay 任务均已完成"
            : "MR 已合并，Relay 任务已完成",
        ).then(() => undefined),
    });
  };

  const requestRelayOnlyCompletion = (task: Task) => {
    setConfirm({
      title: "仅完成 Relay 任务",
      description:
        "这会直接把当前任务标记为已完成，不会创建或合并 MR，也不会修改绑定的轻语缺陷状态。任务分支和历史记录仍会保留。",
      confirmLabel: "仅完成 Relay",
      danger: true,
      action: () =>
        runMutation(
          () =>
            api(`/api/tasks/${task.id}/complete-relay-only`, {
              method: "POST",
            }),
          "Relay 任务已完成；MR 和轻语操作均已跳过",
        ).then(() => undefined),
    });
  };

  const requestBatchTaskCompletion = (tasks: Task[]) => {
    const candidates = tasks.filter((task) => task.status === "waiting_user");
    if (!candidates.length) {
      notify("请先选择待确认任务", "info");
      return;
    }
    setConfirm({
      title: `批量确认完成 ${candidates.length} 个任务`,
      description:
        "系统会按所选顺序逐个处理，避免多个 MR 同时抢占主分支。每个任务内部仍严格执行：GitLab MR 合并 → 对应轻语账号设为“已解决”（如有关联）→ Relay 标记已完成。某个任务失败时只停止该任务的后续步骤，其余所选任务会继续处理。",
      confirmLabel: `一键完成 ${candidates.length} 个`,
      action: async () => {
        setBusy(true);
        try {
          setConfirm((current) =>
            current
              ? {
                  ...current,
                  description: `Relay 后台正在按顺序处理 ${candidates.length} 个任务。每条任务都会依次完成 MR、轻语（如有关联）和 Relay；你可以保持当前页面等待结果。`,
                }
              : current,
          );
          const result = await api<{
            completed: number;
            failed: number;
            results: Array<{
              taskId: string;
              number?: string | number | null;
              status: "completed" | "failed";
            }>;
          }>("/api/tasks/complete-batch", {
            method: "POST",
            body: JSON.stringify({
              taskIds: candidates.map((task) => task.id),
            }),
          });
          if (result.failed) {
            const failedNumbers = result.results
              .filter((item) => item.status === "failed")
              .slice(0, 4)
              .map((item) => item.number || item.taskId)
              .join("、");
            notify(
              `批量完成结束：成功 ${result.completed} 个，失败 ${result.failed} 个（${failedNumbers}${result.failed > 4 ? " 等" : ""}）。失败任务已保留在待确认列表，可修复后重试。`,
              "error",
            );
          } else {
            notify(`已按顺序完成 ${result.completed} 个任务`);
          }
        } catch (error) {
          notify(
            error instanceof Error
              ? `${error.message}；请刷新列表确认后台结果`
              : "批量完成请求失败，请刷新列表确认后台结果",
            "error",
          );
        } finally {
          await refresh(true);
          setBusy(false);
        }
      },
    });
  };

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
    if (next === "system" && id) {
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}?view=system#system-${id}`,
      );
      window.setTimeout(
        () =>
          document
            .querySelector(`#system-${id}`)
            ?.scrollIntoView({ behavior: "smooth", block: "start" }),
        40,
      );
    }
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
      (action === "restart" && ["busy", "reserved"].includes(worker.status));
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
            className={cx(
              "connection-pill",
              connected
                ? "online"
                : connectionChecked
                  ? "offline"
                  : "connecting",
            )}
          >
            {connected ? (
              <Wifi size={15} />
            ) : connectionChecked ? (
              <WifiOff size={15} />
            ) : (
              <LoaderCircle className="spin" size={15} />
            )}
            <div>
              <strong>
                {connected
                  ? "调度服务正常"
                  : connectionChecked
                    ? "服务已断开"
                    : "正在连接"}
              </strong>
              <span>真实 Hyper-V</span>
            </div>
          </div>
          <button
            className="profile-row"
            type="button"
            onClick={() => setIdentityOpen(true)}
            title="切换使用者"
          >
            <span className="avatar">{userInitial(userName)}</span>
            <div>
              <strong>{userName || "选择使用者"}</strong>
              <span>点击切换</span>
            </div>
            <ShieldCheck size={17} />
          </button>
        </div>
      </aside>

      <main className="main-stage">
        {connectionChecked && !connected && (
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
            <IconButton
              label="通知设置"
              onClick={() => navigate("system", "settings")}
            >
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
              currentUser={userName}
              onTask={(id) => navigate("task", id)}
              onWorker={(id) => {
                setSelectedWorkerId(id);
                navigate("system", "workers");
              }}
              onCreate={() => setCreateTaskOpen(true)}
            />
          )}
          {view === "tasks" && (
            <TasksPage
              snapshot={snapshot}
              busy={busy}
              onTask={(id) => navigate("task", id)}
              onComplete={requestTaskCompletion}
              onCompleteMany={requestBatchTaskCompletion}
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
              onMessage={async (message, executionProfile, files) => {
                const ok = await runMutation(async () => {
                  const attachments = [];
                  for (const file of files)
                    attachments.push(await uploadFile(file));
                  return api(`/api/tasks/${selectedTask.id}/messages`, {
                    method: "POST",
                    body: JSON.stringify({
                      message,
                      executionProfile,
                      attachmentIds: attachments.map((item) => item.id),
                    }),
                  });
                }, "新的微调已加入执行队列");
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
              onClose={() => requestTaskCompletion(selectedTask)}
              onCloseRelayOnly={() => requestRelayOnlyCompletion(selectedTask)}
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
          {view === "system" && (
            <SystemPage
              snapshot={snapshot}
              selectedWorker={selectedWorker}
              connected={connected}
              connectionChecked={connectionChecked}
              onSelectWorker={setSelectedWorkerId}
              onWorkerAction={workerAction}
              onCreateWorker={() => {
                setEditingWorker(null);
                setWorkerEditorOpen(true);
              }}
              onEditWorker={(worker) => {
                setEditingWorker(worker);
                setWorkerEditorOpen(true);
              }}
              onCreateProject={() => {
                setEditingProject(null);
                setProjectEditorOpen(true);
              }}
              onEditProject={(project) => {
                setEditingProject(project);
                setProjectEditorOpen(true);
              }}
              onDeleteProject={(project) =>
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
          onBatchSubmit={async (payload, items) => {
            setBusy(true);
            try {
              const uploadedItems = [];
              for (const item of items) {
                const attachments = [];
                for (const file of item.files) {
                  attachments.push(await uploadFile(file));
                }
                uploadedItems.push({
                  defectId: item.defectId,
                  extraPrompt: item.extraPrompt,
                  attachmentIds: attachments.map((attachment) => attachment.id),
                });
              }
              const result: ProjectManagementImportResult = {
                ok: true,
                created: 0,
                duplicates: 0,
                failed: 0,
                results: [],
              };
              for (
                let index = 0;
                index < uploadedItems.length;
                index += PROJECT_MANAGEMENT_IMPORT_CHUNK_SIZE
              ) {
                const chunk = await api<ProjectManagementImportResult>(
                  "/api/project-management/import",
                  {
                    method: "POST",
                    body: JSON.stringify({
                      ...payload,
                      items: uploadedItems.slice(
                        index,
                        index + PROJECT_MANAGEMENT_IMPORT_CHUNK_SIZE,
                      ),
                    }),
                  },
                );
                result.ok = result.ok && chunk.ok;
                result.created += chunk.created;
                result.duplicates += chunk.duplicates;
                result.failed += chunk.failed;
                result.results.push(...chunk.results);
              }
              const summary = [
                result.created > 0 && `新建 ${result.created} 个`,
                result.duplicates > 0 && `跳过重复 ${result.duplicates} 个`,
                result.failed > 0 && `失败 ${result.failed} 个`,
              ]
                .filter(Boolean)
                .join("，");
              notify(
                summary || "没有需要创建的任务",
                result.failed > 0 ? "error" : "success",
              );
              await refresh(true);
              if (result.failed === 0) setCreateTaskOpen(false);
              return result;
            } catch (error) {
              notify(
                error instanceof Error ? error.message : "批量创建任务失败",
                "error",
              );
              throw error;
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

      {identityReady && identityOpen && (
        <IdentityDialog
          currentName={userName}
          canClose={identityReady && Boolean(userName)}
          onClose={() => setIdentityOpen(false)}
          onSave={(value) => {
            const savedUserName = setUserName(value);
            setCurrentUserName(savedUserName);
            setIdentityReady(true);
            setIdentityOpen(false);
          }}
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
  currentUser,
  onTask,
  onWorker,
  onCreate,
}: {
  snapshot: Snapshot;
  currentUser: string;
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
          <h1>下午好，{currentUser || "使用者"}。</h1>
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

      <div className="dashboard-grid dashboard-command-grid">
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

        <MonitorWorktree snapshot={snapshot} onTask={onTask} />
      </div>

      <section className="workspace-panel worker-pool-panel dashboard-worker-pool">
        <div className="section-heading">
          <div>
            <span className="section-kicker">资源层</span>
            <h2>当前工位池</h2>
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
  );
}

function monitorTurnLabel(turn: OpsTurn) {
  if (turn.trigger === "monitor") return `Luna 巡检 · 第 ${turn.sequence} 轮`;
  if (turn.trigger === "incident")
    return `Luna 事故诊断 · 第 ${turn.sequence} 轮`;
  if (turn.trigger === "followup") return `Luna 复核 · 第 ${turn.sequence} 轮`;
  return `Luna 系统轮次 · 第 ${turn.sequence} 轮`;
}

function systemEventKind(event: PipelineEvent) {
  if (event.level === "error" || /failed|error|unhealthy/i.test(event.type))
    return { label: "任务出错", tone: "error", icon: AlertTriangle };
  if (/resolved|recovered|repair.*completed/i.test(event.type))
    return { label: "错误已解决", tone: "recovered", icon: ShieldCheck };
  if (/delivered|released|closed|completed|accepted/i.test(event.type))
    return { label: "任务完成", tone: "success", icon: CheckCircle2 };
  if (/queued|started|prepare|workspace|restore/i.test(event.type))
    return { label: "开始任务", tone: "running", icon: Play };
  return { label: "系统信息", tone: "info", icon: Activity };
}

function isMonitorSystemEvent(event: PipelineEvent) {
  return (
    event.level === "error" ||
    /^(task\.|turn\.(queued|prepare|workspace|restore|unity|codex|delivery|commit|push|delivered|released|cancelled)|worker\.(unhealthy|action)|ops\.(supervisor|recovery|incident|action)|guardian\.|system\.runtime|build\.dispatch\.(accepted|failed))/i.test(
      event.type,
    )
  );
}

function MonitorWorktree({
  snapshot,
  onTask,
}: {
  snapshot: Snapshot;
  onTask: (id: string) => void;
}) {
  const ops = snapshot.ops;
  const supervisor = snapshot.server.ops?.supervisor;
  const systemThread =
    ops.threads.find((thread) => thread.isSystem) ?? ops.thread;
  const rootTurns = ops.turns
    .filter(
      (turn) =>
        turn.threadId === systemThread.id &&
        ["monitor", "incident", "followup"].includes(turn.trigger),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const repairTurns = ops.turns
    .filter((turn) => turn.trigger === "repair")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rootIds = new Set(rootTurns.map((turn) => turn.id));
  const detachedRepairs = repairTurns.filter(
    (turn) => !turn.parentOpsTurnId || !rootIds.has(turn.parentOpsTurnId),
  );
  const systemEvents = snapshot.events
    .filter(isMonitorSystemEvent)
    .slice(-12)
    .reverse();
  const guardianHealthy = snapshot.server.guardian?.reachable !== false;
  const monitorHealthy =
    Boolean(snapshot.server.ops?.running) &&
    Boolean(supervisor?.running) &&
    guardianHealthy;
  const activeRepair = repairTurns.some((turn) =>
    ["queued", "running"].includes(turn.status),
  );
  const activeTaskCount = supervisor?.activeTaskCount ?? 0;

  const renderRepairBranch = (turn: OpsTurn) => {
    const thread = ops.threads.find((item) => item.id === turn.threadId);
    const task = turn.targetTaskId
      ? snapshot.tasks.find((item) => item.id === turn.targetTaskId)
      : null;
    const progress = snapshot.events
      .filter(
        (event) =>
          event.opsTurnId === turn.id &&
          ["ops.codex.message", "ops.recovery.spawned"].includes(event.type),
      )
      .slice(-2);
    const summary =
      turn.errorMessage ||
      turn.final?.summary ||
      progress.at(-1)?.message ||
      (turn.status === "running" ? "正在修复并验证原任务恢复状态" : "等待执行");
    return (
      <article
        className={cx(
          "monitor-repair-branch",
          ["queued", "running"].includes(turn.status) && "active",
          turn.status === "failed" && "failed",
        )}
        key={turn.id}
      >
        <span className="monitor-branch-junction" aria-hidden="true" />
        <div className="monitor-branch-head">
          <span className="monitor-agent-icon sol">
            <GitBranch size={15} />
          </span>
          <div>
            <strong>Sol xhigh 修复分支</strong>
            <small>{thread?.title ?? turn.id}</small>
          </div>
          <StatusBadge status={turn.status} />
        </div>
        <p title={summary}>{summary}</p>
        <div className="monitor-branch-meta">
          <code>
            {thread?.codexThreadId?.slice(0, 12) ?? "等待 Codex thread"}
          </code>
          <time>{relativeTime(turn.startedAt ?? turn.createdAt)}</time>
          {task && (
            <button type="button" onClick={() => onTask(task.id)}>
              {task.number}
              <ArrowRight size={13} />
            </button>
          )}
        </div>
      </article>
    );
  };

  return (
    <section className="workspace-panel monitor-worktree-panel">
      <div className="section-heading monitor-heading">
        <div>
          <span className="section-kicker">监督工作树</span>
          <h2>Relay 自动监控</h2>
        </div>
        <span className={cx("monitor-health", monitorHealthy && "healthy")}>
          <span />
          {monitorHealthy ? "运行正常" : "需要关注"}
        </span>
      </div>

      <div className="monitor-runtime-card">
        <div className="monitor-runtime-main">
          <span className="monitor-agent-icon luna">
            <HeartPulse size={17} />
          </span>
          <div>
            <strong>Luna Max 常驻监督</strong>
            <small>
              {supervisor?.intervalMs
                ? `${Math.round(supervisor.intervalMs / 60_000)} 分钟一次`
                : "等待监督器配置"}
              {" · "}
              {activeTaskCount} 个非终态任务
            </small>
          </div>
          {snapshot.server.ops?.activeSessions ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <CheckCircle2 size={17} />
          )}
        </div>
        <dl className="monitor-runtime-facts">
          <div>
            <dt>上次巡检</dt>
            <dd>{relativeTime(supervisor?.lastCheckAt)}</dd>
          </div>
          <div>
            <dt>下次巡检</dt>
            <dd>{relativeTime(supervisor?.nextCheckAt)}</dd>
          </div>
          <div>
            <dt>修复模型</dt>
            <dd>{activeRepair ? "Sol xhigh 执行中" : "Sol xhigh 待命"}</dd>
          </div>
          <div>
            <dt>Guardian</dt>
            <dd>{guardianHealthy ? "可达" : "失联"}</dd>
          </div>
        </dl>
      </div>

      <div className="monitor-tree-scroll">
        <div className="monitor-tree-root">
          <span className="monitor-root-line" aria-hidden="true" />
          <span className="monitor-root-node">
            <Bot size={15} />
          </span>
          <div>
            <strong>{codexModelLabel(systemThread.codexModel)}</strong>
            <small>
              {systemThread.codexReasoningEffort} · 持久线程{" "}
              {systemThread.codexThreadId?.slice(0, 12) ?? "尚未建立"}
            </small>
          </div>
        </div>

        <div className="monitor-turn-timeline">
          {rootTurns.map((turn) => {
            const progress = snapshot.events
              .filter(
                (event) =>
                  event.opsTurnId === turn.id &&
                  event.type === "ops.codex.message",
              )
              .slice(-2);
            const summary =
              turn.errorMessage ||
              turn.final?.summary ||
              progress.at(-1)?.message ||
              (turn.status === "running"
                ? "正在读取任务、Worker、Unity 与 Git 证据"
                : "巡检已进入队列");
            const children = repairTurns.filter(
              (repair) => repair.parentOpsTurnId === turn.id,
            );
            return (
              <article className="monitor-turn" key={turn.id}>
                <span className="monitor-turn-dot" aria-hidden="true" />
                <div className="monitor-turn-head">
                  <div>
                    <strong>{monitorTurnLabel(turn)}</strong>
                    <time>{relativeTime(turn.createdAt)}</time>
                  </div>
                  <StatusBadge status={turn.status} />
                </div>
                <p title={summary}>{summary}</p>
                {children.length > 0 && (
                  <div className="monitor-repair-branches">
                    {children.map(renderRepairBranch)}
                  </div>
                )}
              </article>
            );
          })}
          {rootTurns.length === 0 && (
            <div className="monitor-tree-empty">
              <ShieldCheck size={18} />
              <span>
                <strong>监督器正在等待需要检查的任务</strong>
                <small>有非终态任务时，每一轮 Luna 结果都会出现在这里。</small>
              </span>
            </div>
          )}
          {detachedRepairs.length > 0 && (
            <div className="monitor-detached-branches">
              <span>历史修复分支</span>
              {detachedRepairs.map(renderRepairBranch)}
            </div>
          )}
        </div>
      </div>

      <div className="monitor-system-events">
        <div className="monitor-subhead">
          <strong>系统事件</strong>
          <span>任务与自动恢复状态</span>
        </div>
        <div className="monitor-event-list">
          {systemEvents.map((event) => {
            const kind = systemEventKind(event);
            const EventIcon = kind.icon;
            const task = event.taskId
              ? snapshot.tasks.find((item) => item.id === event.taskId)
              : null;
            return (
              <button
                type="button"
                className="monitor-event"
                key={event.id}
                disabled={!task}
                onClick={() => task && onTask(task.id)}
              >
                <span className={cx("monitor-event-icon", kind.tone)}>
                  <EventIcon size={13} />
                </span>
                <span>
                  <strong>
                    {kind.label}
                    {task ? ` · ${task.number}` : ""}
                  </strong>
                  <small>{event.message}</small>
                </span>
                <time>{relativeTime(event.createdAt)}</time>
              </button>
            );
          })}
          {systemEvents.length === 0 && (
            <p className="monitor-events-empty">暂无任务或恢复状态变化。</p>
          )}
        </div>
      </div>
    </section>
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
              {event.actorName && (
                <span className="event-actor">{event.actorName}</span>
              )}
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

export function LegacyOpsPage({
  snapshot,
  busy,
  onTask,
  onSend,
  onCreateThread,
  onUpdateThread,
  onClearThread,
  onDiagnose,
  onResolve,
}: {
  snapshot: Snapshot;
  busy: boolean;
  onTask: (id: string) => void;
  onSend: (threadId: string, message: string) => Promise<OpsTurn | null>;
  onCreateThread: (input: {
    title: string;
    codexModel: string;
    codexReasoningEffort: string;
    codexFastMode: boolean;
  }) => Promise<OpsThread | null>;
  onUpdateThread: (
    threadId: string,
    input: Partial<{
      title: string;
      codexModel: string;
      codexReasoningEffort: string;
      codexFastMode: boolean;
    }>,
  ) => Promise<boolean>;
  onClearThread: (threadId: string) => Promise<boolean>;
  onDiagnose: (incidentId: string) => void;
  onResolve: (incidentId: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [optimisticTurns, setOptimisticTurns] = useState<OpsTurn[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState(
    snapshot.ops.thread.id,
  );
  const [creatingThread, setCreatingThread] = useState(false);
  const [newThreadTitle, setNewThreadTitle] = useState("新的系统对话");
  const [newThreadModel, setNewThreadModel] = useState(
    snapshot.ops.thread.codexModel,
  );
  const [newThreadReasoning, setNewThreadReasoning] = useState(
    snapshot.ops.thread.codexReasoningEffort,
  );
  const [newThreadFast, setNewThreadFast] = useState(
    snapshot.ops.thread.codexFastMode,
  );
  const ops = snapshot.ops;
  const threads = ops.threads.length ? ops.threads : [ops.thread];
  const selectedThread =
    threads.find((thread) => thread.id === selectedThreadId) ?? threads[0];
  const supervisor = snapshot.server.ops?.supervisor;
  const snapshotTurnIds = new Set(ops.turns.map((turn) => turn.id));
  const visibleTurns = selectedThread
    ? [
        ...ops.turns,
        ...optimisticTurns.filter((turn) => !snapshotTurnIds.has(turn.id)),
      ]
        .filter((turn) => turn.threadId === selectedThread.id)
        .sort((left, right) => left.sequence - right.sequence)
    : [];
  const selectedModel =
    CODEX_MODEL_OPTIONS.find(
      (option) => option.value === selectedThread?.codexModel,
    ) ?? CODEX_MODEL_OPTIONS[0];
  const selectedReasoningOptions = CODEX_REASONING_OPTIONS.filter((option) =>
    selectedModel.efforts.includes(option.value as never),
  );
  const newModelOption =
    CODEX_MODEL_OPTIONS.find((option) => option.value === newThreadModel) ??
    CODEX_MODEL_OPTIONS[0];
  const newReasoningOptions = CODEX_REASONING_OPTIONS.filter((option) =>
    newModelOption.efforts.includes(option.value as never),
  );
  const activeTurn = visibleTurns.findLast((turn) =>
    ["queued", "running"].includes(turn.status),
  );
  const latestTurn = visibleTurns.at(-1);
  const latestProgress = activeTurn
    ? snapshot.events
        .filter(
          (event) =>
            event.opsTurnId === activeTurn.id &&
            ["ops.codex.message", "ops.repair.progress"].includes(event.type),
        )
        .at(-1)
    : null;
  const threadActive =
    sending ||
    Boolean(activeTurn) ||
    ["queued", "running"].includes(selectedThread?.status ?? "idle");
  const activityTitle = sending
    ? "正在把消息发送给 System Codex"
    : activeTurn?.status === "queued"
      ? "消息已接收，正在等待 System Codex 开始"
      : threadActive
        ? "System Codex 正在思考和处理"
        : latestTurn
          ? "本轮已结束，常驻监督仍在运行"
          : "常驻监督已启动，当前空闲";
  const activityDetail = sending
    ? "正在确认消息送达，请不要重复发送。"
    : activeTurn?.status === "queued"
      ? `第 ${activeTurn.sequence} 轮已经进入队列，不需要重复发送。`
      : threadActive
        ? (latestProgress
            ? readableCodexMessage(latestProgress.message)
            : null) ||
          `第 ${activeTurn?.sequence ?? latestTurn?.sequence ?? 1} 轮仍在继续；收到最终结论前都会保持此状态。`
        : latestTurn
          ? `第 ${latestTurn.sequence} 轮已在 ${relativeTime(latestTurn.finishedAt ?? latestTurn.createdAt)}结束；有非终态任务时每 5 分钟自动复查。`
          : "有非终态任务时每 5 分钟自动检查；发现故障会新建 Sol xhigh 全权限修复对话。";
  const openIncidents = ops.incidents.filter((item) => !item.resolvedAt);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const content = message.trim();
    if (!content || sending || !selectedThread) return;
    setSending(true);
    const turn = await onSend(selectedThread.id, content);
    if (turn) {
      setOptimisticTurns((current) => [
        ...current.filter(
          (item) => item.id !== turn.id && !snapshotTurnIds.has(item.id),
        ),
        turn,
      ]);
      setMessage("");
    }
    setSending(false);
  };
  const createThread = async (event: FormEvent) => {
    event.preventDefault();
    const title = newThreadTitle.trim();
    if (!title) return;
    const thread = await onCreateThread({
      title,
      codexModel: newThreadModel,
      codexReasoningEffort: newThreadReasoning,
      codexFastMode: newThreadFast,
    });
    if (!thread) return;
    setSelectedThreadId(thread.id);
    setCreatingThread(false);
    setNewThreadTitle("新的系统对话");
  };
  const updateSelectedThread = (
    changes: Partial<{
      codexModel: string;
      codexReasoningEffort: string;
      codexFastMode: boolean;
    }>,
  ) => {
    if (!selectedThread) return;
    void onUpdateThread(selectedThread.id, changes);
  };
  return (
    <div className="page ops-page">
      <section className="page-title-row ops-title-row">
        <div>
          <span className="eyebrow">AUTONOMOUS OPERATIONS</span>
          <h1>系统助手</h1>
          <p>
            GPT-5.6 Luna Max 常驻监督会复用同一对话，每 5 分钟检查非终态任务；
            发现真实故障时会启动新的 GPT-5.6 Sol xhigh
            全权限修复对话，保留原任务提示词并负责让原任务恢复运行。
          </p>
        </div>
        <div className="ops-status-cluster">
          <StatusBadge
            status={
              snapshot.server.recoveryMode
                ? "preparing"
                : snapshot.server.ops?.running
                  ? "ready"
                  : "offline"
            }
            label={
              snapshot.server.recoveryMode
                ? "Guardian 恢复模式"
                : snapshot.server.ops?.running
                  ? "自动恢复运行中"
                  : "系统助手离线"
            }
          />
          <span className="ops-thread-meta">
            {selectedThread
              ? `${codexModelLabel(selectedThread.codexModel)} · ${codexReasoningLabel(selectedThread.codexReasoningEffort)}${selectedThread.codexFastMode ? " · Fast" : ""}`
              : "未选择对话"}
            {selectedThread?.isSystem && supervisor?.running
              ? ` · 常驻 ${Math.round((supervisor.intervalMs ?? 300000) / 60000)} 分钟巡检`
              : ""}
          </span>
        </div>
      </section>

      {snapshot.server.recoveryMode && (
        <div className="ops-recovery-banner">
          <ShieldCheck size={19} />
          <div>
            <strong>Relay 主进程当前不可用，已切换到 Guardian。</strong>
            <span>
              这里发送的消息由独立 Emergency Codex
              处理，仍可重启服务或触发隔离代码修复。
            </span>
          </div>
        </div>
      )}

      <div className="ops-layout">
        <aside className="ops-session-rail">
          <div className="ops-session-rail-head">
            <div>
              <span className="section-kicker">CONVERSATIONS</span>
              <h2>系统对话</h2>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="新建系统对话"
              title="新建系统对话"
              onClick={() => setCreatingThread((value) => !value)}
            >
              <MessageSquarePlus size={17} />
            </button>
          </div>
          {creatingThread && (
            <form className="ops-new-session" onSubmit={createThread}>
              <label className="form-field">
                <span>对话名称</span>
                <input
                  value={newThreadTitle}
                  maxLength={120}
                  onChange={(event) => setNewThreadTitle(event.target.value)}
                  placeholder="例如：网页异常排查"
                  autoFocus
                />
              </label>
              <StyledSelect
                label="模型"
                value={newThreadModel}
                options={CODEX_MODEL_OPTIONS}
                onChange={(value) => {
                  setNewThreadModel(value);
                  const option =
                    CODEX_MODEL_OPTIONS.find((item) => item.value === value) ??
                    CODEX_MODEL_OPTIONS[0];
                  if (!option.efforts.includes(newThreadReasoning as never)) {
                    setNewThreadReasoning(
                      option.efforts.includes("xhigh" as never)
                        ? "xhigh"
                        : (option.efforts.at(-1) ?? "high"),
                    );
                  }
                }}
              />
              <StyledSelect
                label="思考深度"
                value={newThreadReasoning}
                options={newReasoningOptions}
                onChange={setNewThreadReasoning}
              />
              <label className="ops-fast-toggle">
                <input
                  type="checkbox"
                  checked={newThreadFast}
                  onChange={(event) => setNewThreadFast(event.target.checked)}
                />
                <span>
                  <Zap size={14} />
                  Fast 模式
                </span>
              </label>
              <div className="ops-new-session-actions">
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setCreatingThread(false)}
                >
                  取消
                </button>
                <button
                  className="primary-action"
                  type="submit"
                  disabled={busy || !newThreadTitle.trim()}
                >
                  <Plus size={15} />
                  创建
                </button>
              </div>
            </form>
          )}
          <div className="ops-session-list">
            {threads.map((thread) => (
              <button
                type="button"
                key={thread.id}
                className={cx(
                  "ops-session-item",
                  selectedThread?.id === thread.id && "active",
                )}
                onClick={() => setSelectedThreadId(thread.id)}
              >
                <span className="ops-session-icon">
                  <Bot size={15} />
                </span>
                <span>
                  <strong>{thread.title}</strong>
                  <small>
                    {codexModelLabel(thread.codexModel)}
                    {thread.codexFastMode ? " · Fast" : ""}
                  </small>
                </span>
                <span className={cx("ops-session-state", thread.status)} />
                <em>{thread.visibleTurnCount ?? 0}</em>
              </button>
            ))}
          </div>
          <p className="ops-session-note">
            不同对话可并行执行；同一对话内仍按顺序运行。
          </p>
        </aside>
        <section className="ops-conversation">
          <div className="ops-conversation-head">
            <div>
              <span className="section-kicker">SYSTEM THREAD</span>
              <h2>{selectedThread?.title ?? "系统对话"}</h2>
            </div>
            <div className="ops-conversation-actions">
              <span>{visibleTurns.length} 轮</span>
              <button
                className="secondary-action compact"
                type="button"
                disabled={
                  busy ||
                  threadActive ||
                  visibleTurns.length === 0 ||
                  !selectedThread
                }
                onClick={() =>
                  selectedThread && void onClearThread(selectedThread.id)
                }
                title="只清除当前屏幕记录，Codex 上下文和审计历史仍然保留"
              >
                <Eraser size={15} />
                清屏
              </button>
            </div>
          </div>
          {selectedThread && (
            <div className="ops-session-settings">
              <StyledSelect
                label="模型"
                value={selectedThread.codexModel}
                options={CODEX_MODEL_OPTIONS}
                disabled={busy || threadActive}
                onChange={(value) => {
                  const option =
                    CODEX_MODEL_OPTIONS.find((item) => item.value === value) ??
                    CODEX_MODEL_OPTIONS[0];
                  const nextReasoning = option.efforts.includes(
                    selectedThread.codexReasoningEffort as never,
                  )
                    ? selectedThread.codexReasoningEffort
                    : option.efforts.includes("xhigh" as never)
                      ? "xhigh"
                      : (option.efforts.at(-1) ?? "high");
                  updateSelectedThread({
                    codexModel: value,
                    codexReasoningEffort: nextReasoning,
                  });
                }}
              />
              <StyledSelect
                label="思考深度"
                value={selectedThread.codexReasoningEffort}
                options={selectedReasoningOptions}
                disabled={busy || threadActive}
                onChange={(value) =>
                  updateSelectedThread({ codexReasoningEffort: value })
                }
              />
              <label
                className={cx(
                  "ops-fast-toggle",
                  (busy || threadActive) && "disabled",
                )}
              >
                <input
                  type="checkbox"
                  checked={selectedThread.codexFastMode}
                  disabled={busy || threadActive}
                  onChange={(event) =>
                    updateSelectedThread({
                      codexFastMode: event.target.checked,
                    })
                  }
                />
                <span>
                  <Zap size={14} />
                  Fast
                </span>
              </label>
              <span className="ops-settings-note">
                {threadActive
                  ? "运行中，设置将在本轮结束后可修改"
                  : "设置仅影响此对话的后续轮次"}
              </span>
            </div>
          )}
          <div
            className={cx(
              "ops-conversation-activity",
              threadActive ? "active" : "stopped",
            )}
            role="status"
            aria-live="polite"
          >
            <div className="ops-activity-copy">
              <span className="ops-activity-icon" aria-hidden="true">
                {threadActive ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Square size={13} />
                )}
              </span>
              <span>
                <strong>{activityTitle}</strong>
                <small>{activityDetail}</small>
              </span>
            </div>
            <div
              className="ops-activity-track"
              role={threadActive ? "progressbar" : undefined}
              aria-label={threadActive ? "System Codex 仍在运行" : undefined}
            >
              <span />
            </div>
          </div>
          <div className="ops-thread">
            {visibleTurns.length === 0 ? (
              <EmptyState
                icon={Bot}
                title="系统 Codex 已待命"
                description="异常会自动出现在这里，也可以直接描述要诊断、恢复或改进的内容。"
              />
            ) : (
              visibleTurns.map((turn) => {
                const progress = snapshot.events.filter(
                  (event) =>
                    event.opsTurnId === turn.id &&
                    event.type === "ops.codex.message",
                );
                return (
                  <article className="ops-turn" key={turn.id}>
                    <div className="ops-user-message">
                      <div className="message-head">
                        <span className="avatar small">
                          {userInitial(turn.authorName)}
                        </span>
                        <strong>{turn.authorName}</strong>
                        <span className="message-kind">{turn.trigger}</span>
                        <time>{relativeTime(turn.createdAt)}</time>
                        <StatusBadge status={turn.status} />
                      </div>
                      <p>{turn.userMessage}</p>
                    </div>
                    {progress.map((event) => (
                      <div
                        className="ops-agent-message progress"
                        key={event.id}
                      >
                        <div className="message-head">
                          <span className="bot-avatar">
                            <Bot size={16} />
                          </span>
                          <strong>System Codex</strong>
                          <span className="message-kind">进度</span>
                          <time>{relativeTime(event.createdAt)}</time>
                        </div>
                        <p>{event.message}</p>
                      </div>
                    ))}
                    {turn.final?.summary && (
                      <div className="ops-agent-message final">
                        <div className="message-head">
                          <span className="bot-avatar">
                            <Bot size={16} />
                          </span>
                          <strong>System Codex</strong>
                          <span className="message-kind">结论</span>
                        </div>
                        <p>{turn.final.summary}</p>
                        {turn.final.diagnosis && (
                          <div className="ops-diagnosis">
                            <strong>诊断</strong>
                            <span>{turn.final.diagnosis}</span>
                          </div>
                        )}
                        {turn.final.verification && (
                          <div className="ops-diagnosis">
                            <strong>验证</strong>
                            <span>{turn.final.verification}</span>
                          </div>
                        )}
                      </div>
                    )}
                    {turn.errorMessage && (
                      <div className="ops-turn-error">
                        <AlertTriangle size={15} />
                        {turn.errorMessage}
                      </div>
                    )}
                  </article>
                );
              })
            )}
          </div>
          <form className="ops-composer" onSubmit={submit}>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="直接要求系统 Codex 检查任务、恢复 Worker、重启服务或修复 Relay 自身问题…"
              rows={4}
            />
            <div>
              <span>
                {threadActive ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <ShieldCheck size={14} />
                )}
                {threadActive
                  ? "System Codex 仍在继续处理；上方进度条停止后才表示本轮结束。"
                  : "修复对话不受旧动作目录和只读沙箱限制；原任务提示词由不可变归档保护。"}
              </span>
              <button
                className="primary-action"
                type="submit"
                disabled={busy || sending || !message.trim() || !selectedThread}
              >
                {sending ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Bot size={16} />
                )}
                发送给系统 Codex
              </button>
            </div>
          </form>
        </section>

        <aside className="ops-sidebar">
          <section className="ops-panel">
            <div className="ops-panel-head">
              <div>
                <span className="section-kicker">INCIDENTS</span>
                <h2>自动事故处理</h2>
              </div>
              <em>{openIncidents.length}</em>
            </div>
            <div className="incident-list">
              {openIncidents.length === 0 ? (
                <p className="ops-empty-copy">当前没有未解决事故。</p>
              ) : (
                openIncidents.map((incident) => (
                  <article className="incident-card" key={incident.id}>
                    <div>
                      <StatusBadge status={incident.status} />
                      <time>{relativeTime(incident.updatedAt)}</time>
                    </div>
                    <strong>{incident.title}</strong>
                    <p>{incident.error}</p>
                    <dl>
                      <div>
                        <dt>自动尝试</dt>
                        <dd>{incident.attemptCount}</dd>
                      </div>
                      <div>
                        <dt>最后动作</dt>
                        <dd>{incident.lastAction ?? "正在诊断"}</dd>
                      </div>
                    </dl>
                    <div className="incident-actions">
                      {incident.taskId && (
                        <button
                          className="text-button"
                          onClick={() => onTask(incident.taskId!)}
                        >
                          查看任务
                        </button>
                      )}
                      <button
                        className="text-button"
                        onClick={() => onDiagnose(incident.id)}
                      >
                        立即重诊
                      </button>
                      <button
                        className="text-button"
                        onClick={() => onResolve(incident.id)}
                      >
                        标记解决
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>

          <section className="ops-panel">
            <div className="ops-panel-head">
              <div>
                <span className="section-kicker">REPAIR HISTORY</span>
                <h2>自修复提交</h2>
              </div>
              <GitCommitHorizontal size={18} />
            </div>
            <div className="repair-list">
              {ops.repairs.length === 0 ? (
                <p className="ops-empty-copy">尚未触发 Relay 代码修复。</p>
              ) : (
                ops.repairs.slice(0, 8).map((repair) => (
                  <article key={repair.id}>
                    <div>
                      <StatusBadge status={repair.status} />
                      <time>{relativeTime(repair.updatedAt)}</time>
                    </div>
                    <strong>{repair.branchName ?? repair.id}</strong>
                    {repair.commitSha && (
                      <code>{compactSha(repair.commitSha)}</code>
                    )}
                    {repair.error && <p>{repair.error}</p>}
                  </article>
                ))
              )}
            </div>
          </section>

          <section className="ops-panel">
            <div className="ops-panel-head">
              <div>
                <span className="section-kicker">AUDIT</span>
                <h2>最近自动动作</h2>
              </div>
              <History size={18} />
            </div>
            <div className="ops-action-list">
              {ops.actions.slice(0, 12).map((action) => (
                <div key={action.id}>
                  <StatusBadge status={action.status} />
                  <code>{action.type}</code>
                  <span>{action.reason}</span>
                </div>
              ))}
              {ops.actions.length === 0 && (
                <p className="ops-empty-copy">尚无自动动作记录。</p>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function TasksPage({
  snapshot,
  busy,
  onTask,
  onComplete,
  onCompleteMany,
  onCreate,
}: {
  snapshot: Snapshot;
  busy: boolean;
  onTask: (id: string) => void;
  onComplete: (task: Task) => void;
  onCompleteMany: (tasks: Task[]) => void;
  onCreate: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const filters = [
    ["all", "全部"],
    ["running", "执行中"],
    ["queued", "排队中"],
    ["recovering", "自动恢复"],
    ["waiting_user", "等待我确认"],
    ["needs_attention", "需要处理"],
    ["closed", "已完成"],
  ];
  const tasks = snapshot.tasks.filter((task) => {
    if (filter !== "all" && task.status !== filter) return false;
    const project = projectById(snapshot, task.projectId);
    const haystack =
      `${task.number} ${task.title} ${task.createdBy} ${task.branchName} ${task.latestCommitSha ?? ""} ${project?.name ?? ""}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });
  const batchMode = filter === "waiting_user";
  const batchCandidates = tasks.filter(
    (task) => task.status === "waiting_user",
  );
  const selectedTasks = batchCandidates.filter((task) =>
    selectedTaskIds.has(task.id),
  );
  const allVisibleSelected =
    batchCandidates.length > 0 &&
    selectedTasks.length === batchCandidates.length;

  const selectTask = (taskId: string, selected: boolean) => {
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      if (selected) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  };
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
      {batchMode && (
        <div className="task-batch-toolbar">
          <label className="batch-select-all">
            <span className="defect-checkbox">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                disabled={!batchCandidates.length || busy}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setSelectedTaskIds((current) => {
                    const next = new Set(current);
                    for (const task of batchCandidates) {
                      if (checked) next.add(task.id);
                      else next.delete(task.id);
                    }
                    return next;
                  });
                }}
              />
              <span />
            </span>
            <span>全选当前列表</span>
          </label>
          <span className="batch-selection-summary">
            已选 <strong>{selectedTasks.length}</strong> 个 · 当前共{" "}
            {batchCandidates.length} 个
          </span>
          <button
            type="button"
            className="primary-action compact batch-complete-action"
            disabled={!selectedTasks.length || busy}
            onClick={() => onCompleteMany(selectedTasks)}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <CheckCheck size={16} />
            )}
            一键完成 {selectedTasks.length || ""}
          </button>
        </div>
      )}
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
          const buildDispatch = taskBuildDispatches(snapshot, task.id)[0];
          return (
            <div
              className={cx(
                "task-archive-row",
                batchMode && selectedTaskIds.has(task.id) && "batch-selected",
              )}
              key={task.id}
              role="button"
              tabIndex={0}
              onClick={() => onTask(task.id)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onTask(task.id);
                }
              }}
            >
              <div className="archive-signal">
                {batchMode ? (
                  <label
                    className="defect-checkbox archive-select-checkbox"
                    aria-label={`选择 ${task.number}`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selectedTaskIds.has(task.id)}
                      disabled={busy || task.completion?.status === "running"}
                      onChange={(event) =>
                        selectTask(task.id, event.target.checked)
                      }
                    />
                    <span />
                  </label>
                ) : (
                  <span
                    className={cx("archive-dot", `status-${task.status}`)}
                  />
                )}
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
                  <span>{task.createdBy}</span>
                  <i />
                  <code>{task.branchName}</code>
                  <i />
                  <span>{allTurns.length} 轮</span>
                  {task.projectManagement?.defectId && (
                    <>
                      <i />
                      <span>
                        轻语 {task.projectManagement.defectId}
                        {task.projectManagement.userName
                          ? ` · ${task.projectManagement.userName}`
                          : ""}
                      </span>
                    </>
                  )}
                </div>
                {buildDispatch && (
                  <div className="archive-build-status">
                    <BuildStatusPill dispatch={buildDispatch} />
                  </div>
                )}
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
              <div className="archive-actions">
                {task.status === "waiting_user" && (
                  <button
                    type="button"
                    className="archive-complete-action"
                    disabled={busy || task.completion?.status === "running"}
                    onClick={(event) => {
                      event.stopPropagation();
                      onComplete(task);
                    }}
                  >
                    {task.completion?.status === "running" ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Check size={14} />
                    )}
                    {task.completion?.status === "failed"
                      ? "重试完成"
                      : "确认完成"}
                  </button>
                )}
                <ChevronRight size={18} />
              </div>
            </div>
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
  onCloseRelayOnly,
  onReopen,
}: {
  snapshot: Snapshot;
  task: Task;
  events: PipelineEvent[];
  busy: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onMessage: (
    message: string,
    executionProfile: ExecutionProfile,
    files: File[],
  ) => Promise<boolean>;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
  onCloseRelayOnly: () => void;
  onReopen: () => void;
}) {
  const turns = snapshot.turns
    .filter((turn) => turn.taskId === task.id)
    .sort((a, b) => a.sequence - b.sequence);
  const latest = turns.at(-1);
  const current =
    turns.findLast((turn) => EXECUTING_TURN.has(turn.status)) ?? latest;
  const project = projectById(snapshot, task.projectId);
  const worker = snapshot.workers.find((item) => item.id === current?.workerId);
  const [message, setMessage] = useState("");
  const [executionProfile, setExecutionProfile] =
    useState<ExecutionProfile>("auto");
  const [files, setFiles] = useState<File[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const active = turns.some((turn) => LIVE_TURN.has(turn.status));
  const closed = task.status === "closed";
  const buildDispatches = taskBuildDispatches(snapshot, task.id);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim() || sending) return;
    setSending(true);
    const ok = await onMessage(message.trim(), executionProfile, files);
    if (ok) {
      setMessage("");
      setFiles([]);
      setExecutionProfile("auto");
    }
    setSending(false);
  };
  const addFiles = (incoming: File[]) =>
    setFiles((current) => mergeUniqueFiles(current, incoming));
  const pasteImages = (event: ReactClipboardEvent<HTMLTextAreaElement>) =>
    addFiles(clipboardImages(event));
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
              <span className="avatar micro">
                {userInitial(task.createdBy)}
              </span>
              {task.createdBy}
            </span>
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
          {!active && !closed && task.status === "waiting_user" && (
            <button
              className="secondary-action danger-text"
              onClick={onCloseRelayOnly}
              disabled={busy || task.completion?.status === "running"}
            >
              <CheckCircle2 size={15} />
              仅完成 Relay
            </button>
          )}
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
            <button
              className="secondary-action"
              onClick={onClose}
              disabled={busy || task.completion?.status === "running"}
            >
              {task.completion?.status === "running" ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Check size={15} />
              )}
              {task.completion?.status === "failed"
                ? "重试确认完成"
                : task.completion?.status === "running"
                  ? "正在完成"
                  : "确认完成"}
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
          <form className="message-composer" onSubmit={submit}>
            <div className="composer-label">
              <MessageSquareText size={15} />
              <strong>
                {closed
                  ? "发送消息将重新打开任务"
                  : active
                    ? "本轮执行中，可继续排队"
                    : "继续在这条任务中微调"}
              </strong>
              <span>
                {closed
                  ? `将创建第 ${(latest?.sequence ?? 0) + 1} 轮`
                  : active
                    ? "新消息会按顺序执行，不会并发修改分支"
                    : `将创建第 ${(latest?.sequence ?? 0) + 1} 轮`}
              </span>
            </div>
            <div className="composer-route">
              <label>
                <span>本轮辅助判断</span>
                <select
                  value={executionProfile}
                  disabled={sending}
                  onChange={(event) =>
                    setExecutionProfile(event.target.value as ExecutionProfile)
                  }
                >
                  {EXECUTION_PROFILE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <small>
                {
                  EXECUTION_PROFILE_OPTIONS.find(
                    (option) => option.value === executionProfile,
                  )?.detail
                }
              </small>
            </div>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onPaste={pasteImages}
              disabled={sending}
              placeholder="例如：继续处理当前现场，或补充新的微调要求；可以直接 Ctrl+V 粘贴截图…"
            />
            <div className="attachment-actions composer-attachment-actions">
              <label className="attachment-button">
                <Paperclip size={16} />
                添加图片或文件
                <input
                  type="file"
                  multiple
                  disabled={sending}
                  onChange={(event) => {
                    addFiles(Array.from(event.target.files ?? []));
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              <span>第二轮及后续提示词也支持直接粘贴截图</span>
            </div>
            {files.length > 0 && (
              <div
                className="attachment-list composer-attachment-list"
                aria-label="本轮已添加的文件"
              >
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
            <div className="composer-foot">
              <span>
                <GitBranch size={13} />
                沿用 {task.branchName} 与原 Codex 对话
              </span>
              <button
                className="primary-action"
                disabled={sending || !message.trim()}
              >
                {sending ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <ArrowRight size={16} />
                )}
                {active ? "加入队列" : "追加一轮"}
              </button>
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
                <dt>任务来源</dt>
                <dd>
                  {task.projectManagement?.defectId ? (
                    task.projectManagement.defectUrl ? (
                      <a
                        href={task.projectManagement.defectUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        轻语 {task.projectManagement.defectId}
                        {task.projectManagement.userName
                          ? ` · ${task.projectManagement.userName}`
                          : ""}
                      </a>
                    ) : (
                      `轻语 ${task.projectManagement.defectId}${
                        task.projectManagement.userName
                          ? ` · ${task.projectManagement.userName}`
                          : ""
                      }`
                    )
                  ) : (
                    "Relay"
                  )}
                </dd>
              </div>
              {task.completion?.mergeRequestIid && (
                <div>
                  <dt>合并请求</dt>
                  <dd>
                    {task.completion.mergeRequestUrl ? (
                      <a
                        href={task.completion.mergeRequestUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        MR !{task.completion.mergeRequestIid}
                      </a>
                    ) : (
                      `MR !${task.completion.mergeRequestIid}`
                    )}
                  </dd>
                </div>
              )}
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
            {task.completion?.status === "failed" && (
              <div className="preserved-error compact completion-error">
                <AlertTriangle size={18} />
                <div>
                  <strong>
                    {task.completion.step === "project_management"
                      ? "MR 已合并，轻语更新失败"
                      : task.completion.step === "relay"
                        ? "Relay 最终状态写入失败"
                        : "自动 MR 合并失败"}
                  </strong>
                  <p>{task.completion.errorMessage || "确认完成流程已停止"}</p>
                  <code>{task.completion.errorCode}</code>
                </div>
              </div>
            )}
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
      {buildDispatches.length > 0 && (
        <section className="task-build-progress" aria-label="热更打包进度">
          <div className="task-build-progress-title">
            <div>
              <span className="eyebrow">HOT UPDATE BUILD</span>
              <h2>热更打包进度</h2>
              <p>
                代码交付后，本任务就已完成并释放队列；下面的打包状态独立更新，不会延迟下一条任务。
              </p>
            </div>
            <BuildStatusPill dispatch={buildDispatches[0]} />
          </div>
          <div className="task-build-progress-list">
            {buildDispatches.map((dispatch) => (
              <BuildProgressCard key={dispatch.id} dispatch={dispatch} />
            ))}
          </div>
        </section>
      )}
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
          <span className="avatar small">{userInitial(turn.authorName)}</span>
          <strong>{turn.authorName}</strong>
          <span className="message-kind user-message-kind">
            {turn.sequence === 1 ? "初始提示词" : "补充要求"}
          </span>
          <span className="message-kind route-kind">
            {executionProfileLabel(turn.executionProfile)}
          </span>
          <time>{relativeTime(turn.createdAt)}</time>
          <StatusBadge status={turn.status} label={`第 ${turn.sequence} 轮`} />
        </div>
        <p>{turn.userMessage}</p>
        {turn.attachments && turn.attachments.length > 0 && (
          <TurnAttachments attachments={turn.attachments} />
        )}
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

function previewableImage(contentType?: string | null) {
  return [
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ].includes(String(contentType || "").toLowerCase());
}

function attachmentTypeLabel(attachment: Attachment) {
  const extension = attachment.filename.split(".").at(-1);
  if (extension && extension !== attachment.filename)
    return extension.toUpperCase();
  return attachment.contentType || "文件";
}

function TurnAttachmentThumbnail({ attachment }: { attachment: Attachment }) {
  const url = `${getApiBase()}/api/attachments/${encodeURIComponent(attachment.id)}`;
  if (!previewableImage(attachment.contentType))
    return (
      <span className="turn-attachment-file-icon">
        <FileCode2 size={22} />
      </span>
    );
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={attachment.filename} loading="lazy" />;
}

function TurnAttachments({ attachments }: { attachments: Attachment[] }) {
  return (
    <section
      className="turn-attachments"
      aria-label={`本轮附件，共 ${attachments.length} 个`}
    >
      <div className="turn-attachments-head">
        <Paperclip size={14} />
        <strong>附件</strong>
        <span>{attachments.length} 个</span>
      </div>
      <div className="turn-attachment-grid">
        {attachments.map((attachment) => {
          const url = `${getApiBase()}/api/attachments/${encodeURIComponent(attachment.id)}`;
          return (
            <a
              className="turn-attachment-card"
              href={url}
              target="_blank"
              rel="noreferrer"
              key={attachment.id}
              title={`打开 ${attachment.filename}`}
            >
              <TurnAttachmentThumbnail attachment={attachment} />
              <span>
                <strong>{attachment.filename}</strong>
                <small>
                  {attachmentTypeLabel(attachment)} ·{" "}
                  {formatFileSize(attachment.size)}
                </small>
              </span>
            </a>
          );
        })}
      </div>
    </section>
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

function SystemPage({
  snapshot,
  selectedWorker,
  connected,
  connectionChecked,
  onSelectWorker,
  onWorkerAction,
  onCreateWorker,
  onEditWorker,
  onCreateProject,
  onEditProject,
  onDeleteProject,
  onSaved,
  notify,
}: {
  snapshot: Snapshot;
  selectedWorker: Worker | null;
  connected: boolean;
  connectionChecked: boolean;
  onSelectWorker: (id: string | null) => void;
  onWorkerAction: (worker: Worker, action: string) => void;
  onCreateWorker: () => void;
  onEditWorker: (worker: Worker) => void;
  onCreateProject: () => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onSaved: () => void;
  notify: (message: string, kind?: Toast["kind"]) => void;
}) {
  const [hostMetrics, setHostMetrics] = useState<HostMetricsSnapshot | null>(
    null,
  );
  const [hostMetricsError, setHostMetricsError] = useState<string | null>(null);
  const enabledProjects = snapshot.projects.filter(
    (project) => project.enabled,
  ).length;
  const healthyWorkers = snapshot.workers.filter((worker) =>
    ["ready", "busy", "preparing"].includes(worker.status),
  ).length;
  const runtimeReady =
    Boolean(snapshot.server.runtime?.ready) &&
    Boolean(snapshot.server.runtime?.hyperv.canManage) &&
    Boolean(snapshot.server.runtime?.codex.authenticated);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const metrics = await fetchHostMetrics(controller.signal);
        if (!disposed) {
          setHostMetrics(metrics);
          setHostMetricsError(null);
        }
      } catch (error) {
        if (
          !disposed &&
          !(error instanceof DOMException && error.name === "AbortError")
        )
          setHostMetricsError(
            error instanceof Error ? error.message : "宿主机性能采样暂不可用",
          );
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      controller?.abort();
    };
  }, []);

  const metricCards = [
    {
      key: "cpu",
      label: "CPU",
      icon: <Cpu size={18} />,
      available: Boolean(hostMetrics?.cpu.available),
      value:
        hostMetrics?.cpu.usagePercent != null
          ? `${hostMetrics.cpu.usagePercent.toFixed(1)}%`
          : null,
      percent: hostMetrics?.cpu.usagePercent,
      detail: hostMetrics
        ? `${hostMetrics.cpu.logicalProcessors} 线程 · 处理器总负载`
        : null,
    },
    {
      key: "memory",
      label: "内存",
      icon: <MemoryStick size={18} />,
      available: Boolean(hostMetrics?.memory.available),
      value:
        hostMetrics?.memory.usagePercent != null
          ? `${hostMetrics.memory.usagePercent.toFixed(1)}%`
          : null,
      percent: hostMetrics?.memory.usagePercent,
      detail:
        hostMetrics?.memory.usedBytes != null &&
        hostMetrics.memory.totalBytes != null
          ? `${formatMetricBytes(hostMetrics.memory.usedBytes)} / ${formatMetricBytes(hostMetrics.memory.totalBytes)}`
          : null,
    },
    {
      key: "temperature",
      label: "温度",
      icon: <Thermometer size={18} />,
      available: Boolean(hostMetrics?.temperature.available),
      value:
        hostMetrics?.temperature.celsius != null
          ? `${hostMetrics.temperature.celsius.toFixed(1)}°C`
          : null,
      percent:
        hostMetrics?.temperature.celsius != null
          ? Math.min(100, hostMetrics.temperature.celsius)
          : null,
      detail: hostMetrics?.temperature.available
        ? `${hostMetrics.temperature.sensor}${hostMetrics.temperature.kind === "gpu" ? " · GPU 温度回退" : ""}`
        : null,
    },
    {
      key: "gpu",
      label: "显卡",
      icon: <MonitorCog size={18} />,
      available: Boolean(hostMetrics?.gpu.available),
      value:
        hostMetrics?.gpu.usagePercent != null
          ? `${hostMetrics.gpu.usagePercent.toFixed(1)}%`
          : null,
      percent: hostMetrics?.gpu.usagePercent,
      detail: hostMetrics?.gpu.name
        ? `${hostMetrics.gpu.name}${hostMetrics.gpu.memoryUsagePercent != null ? ` · 显存 ${hostMetrics.gpu.memoryUsagePercent.toFixed(1)}%` : ""}`
        : null,
    },
    {
      key: "disk",
      label: "硬盘",
      icon: <HardDrive size={18} />,
      available: Boolean(hostMetrics?.disk.available),
      value:
        hostMetrics?.disk.capacityUsagePercent != null
          ? `${hostMetrics.disk.capacityUsagePercent.toFixed(1)}%`
          : null,
      percent: hostMetrics?.disk.capacityUsagePercent,
      danger: Boolean(
        hostMetrics?.disk.volumes.some(
          (volume) => (volume.usagePercent ?? 0) > 80,
        ),
      ),
      volumes: hostMetrics?.disk.volumes ?? [],
      totalBytes: hostMetrics?.disk.totalBytes ?? null,
      detail:
        hostMetrics?.disk.usedBytes != null &&
        hostMetrics.disk.totalBytes != null
          ? `${formatMetricBytes(hostMetrics.disk.usedBytes)} / ${formatMetricBytes(hostMetrics.disk.totalBytes)} 已用`
          : null,
    },
  ];

  return (
    <div className="page system-hub-page">
      <section className="page-title-row system-hub-title">
        <div>
          <span className="eyebrow">SYSTEM & ENVIRONMENTS</span>
          <h1>系统与环境</h1>
          <p>在一个页面管理项目环境、Hyper-V 工位和 Relay 运行设置。</p>
        </div>
        <StatusBadge
          status={connected && runtimeReady ? "ready" : "preparing"}
          label={
            connected && runtimeReady
              ? "系统环境正常"
              : connectionChecked
                ? "部分能力待检查"
                : "正在连接"
          }
        />
      </section>

      <div className="system-hub-stats">
        <div>
          <FolderGit2 size={17} />
          <span>
            <strong>{snapshot.projects.length}</strong>
            <small>{enabledProjects} 个项目已启用</small>
          </span>
        </div>
        <div>
          <Server size={17} />
          <span>
            <strong>{snapshot.workers.length}</strong>
            <small>{healthyWorkers} 个工位可调度</small>
          </span>
        </div>
        <div>
          <Cpu size={17} />
          <span>
            <strong>
              {snapshot.server.runtime?.hyperv.vmCount ??
                snapshot.workers.length}
            </strong>
            <small>Hyper-V 虚拟机</small>
          </span>
        </div>
        <div>
          <HeartPulse size={17} />
          <span>
            <strong>
              {snapshot.server.schedulerRunning === false ? "暂停" : "运行中"}
            </strong>
            <small>Relay 调度循环</small>
          </span>
        </div>
      </div>

      <section
        className="host-performance-panel"
        id="system-performance"
        aria-labelledby="host-performance-title"
      >
        <div className="host-performance-heading">
          <div>
            <span className="host-performance-icon">
              <Activity size={17} />
            </span>
            <span>
              <strong id="host-performance-title">当前宿主机性能</strong>
              <small>
                {hostMetrics
                  ? `最后采样 ${new Date(hostMetrics.sampledAt).toLocaleTimeString("zh-CN", { hour12: false })}`
                  : hostMetricsError
                    ? "采样服务暂不可用"
                    : "正在读取 Windows 性能数据"}
              </small>
            </span>
          </div>
          <span
            className={cx(
              "host-performance-live",
              hostMetricsError && "unavailable",
            )}
            title={hostMetricsError ?? undefined}
          >
            <i aria-hidden="true" />
            {hostMetricsError ? "等待恢复" : "每 3 秒刷新"}
          </span>
        </div>
        <div className="host-performance-grid" aria-live="polite">
          {metricCards.map((metric) => (
            <article
              className={cx(
                "host-metric-card",
                hostMetrics && !metric.available && "unavailable",
                metric.danger && "danger",
              )}
              key={metric.key}
            >
              <div className="host-metric-label">
                <span>{metric.icon}</span>
                <small>{metric.label}</small>
              </div>
              <strong>
                {metric.value ??
                  (hostMetrics
                    ? "不可用"
                    : hostMetricsError
                      ? "等待恢复"
                      : "采样中")}
              </strong>
              {metric.key === "disk" && metric.volumes?.length ? (
                <HostDiskCapacityBar
                  totalBytes={metric.totalBytes}
                  volumes={metric.volumes}
                />
              ) : (
                <div className="host-metric-bar" aria-hidden="true">
                  <span
                    style={{
                      width: `${Math.min(100, Math.max(0, metric.percent ?? 0))}%`,
                    }}
                  />
                </div>
              )}
              <small className="host-metric-detail">
                {metric.detail ??
                  (hostMetrics
                    ? "当前系统未提供此项传感器数据"
                    : "正在建立采样基线")}
              </small>
            </article>
          ))}
        </div>
      </section>

      <nav className="system-hub-nav" aria-label="系统页面分区">
        <a href="#system-performance">
          <Activity size={15} />
          宿主机性能
          <span>5</span>
        </a>
        <a href="#system-projects">
          <FolderGit2 size={15} />
          项目环境
          <span>{snapshot.projects.length}</span>
        </a>
        <a href="#system-workers">
          <Server size={15} />
          工位资源
          <span>{snapshot.workers.length}</span>
        </a>
        <a href="#system-settings">
          <Settings size={15} />
          运行设置
        </a>
      </nav>

      <section
        className="system-hub-section system-projects-section"
        id="system-projects"
      >
        <ProjectsPage
          snapshot={snapshot}
          onCreate={onCreateProject}
          onEdit={onEditProject}
          onDelete={onDeleteProject}
        />
      </section>

      <section
        className="system-hub-section system-workers-section"
        id="system-workers"
      >
        <WorkersPage
          snapshot={snapshot}
          selected={selectedWorker}
          onSelect={onSelectWorker}
          onAction={onWorkerAction}
          onCreate={onCreateWorker}
          onEdit={onEditWorker}
        />
      </section>

      <section
        className="system-hub-section system-settings-section"
        id="system-settings"
      >
        <SettingsPage
          snapshot={snapshot}
          connected={connected}
          connectionChecked={connectionChecked}
          onSaved={onSaved}
          notify={notify}
        />
      </section>
    </div>
  );
}

function formatMetricBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex >= 3 ? 1 : 0)} ${units[unitIndex]}`;
}

function HostDiskCapacityBar({
  totalBytes,
  volumes,
}: {
  totalBytes: number | null;
  volumes: HostMetricsSnapshot["disk"]["volumes"];
}) {
  const effectiveTotal =
    totalBytes ?? volumes.reduce((sum, volume) => sum + volume.totalBytes, 0);
  const description = volumes
    .map(
      (volume) =>
        `${volume.name} ${volume.usagePercent?.toFixed(1) ?? "未知"}% 已用`,
    )
    .join("，");

  return (
    <div
      className="host-disk-capacity-bar"
      role="img"
      aria-label={`固定磁盘容量分段：${description}`}
    >
      {volumes.map((volume) => {
        const usagePercent = Math.min(
          100,
          Math.max(0, volume.usagePercent ?? 0),
        );
        const capacityPercent =
          effectiveTotal > 0
            ? (volume.totalBytes / effectiveTotal) * 100
            : 100 / volumes.length;
        const danger = usagePercent > 80;
        return (
          <span
            className={cx("host-disk-volume", danger && "danger")}
            key={volume.name}
            style={{ flexBasis: `${capacityPercent}%` }}
            title={`${volume.name} ${formatMetricBytes(volume.usedBytes)} / ${formatMetricBytes(volume.totalBytes)}，已用 ${usagePercent.toFixed(1)}%`}
          >
            <i style={{ width: `${usagePercent}%` }} aria-hidden="true" />
            <small>
              <b>{volume.name}</b>
              {usagePercent.toFixed(1)}%
            </small>
          </span>
        );
      })}
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
    { label: "自动恢复中", statuses: ["offline"] },
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
        {worker.status === "reserved" && (
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
                <span className="cell-sub">
                  {project.autoBuildEnabled
                    ? `${project.buildProjectKey || "未配置"} CDN 自动构建`
                    : "CDN 自动构建关闭"}
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
  connectionChecked,
  onSaved,
  notify,
}: {
  snapshot: Snapshot;
  connected: boolean;
  connectionChecked: boolean;
  onSaved: () => void;
  notify: (message: string, kind?: Toast["kind"]) => void;
}) {
  const [base, setBase] = useState(() => getApiBase());
  const [changingScheduler, setChangingScheduler] = useState(false);
  const save = () => {
    setBase(setApiBase(base));
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
          status={
            connected ? "ready" : connectionChecked ? "offline" : "preparing"
          }
          label={
            connected
              ? "实时连接正常"
              : connectionChecked
                ? "服务已断开"
                : "正在连接"
          }
        />
      </section>
      <div className="settings-layout">
        <section className="settings-main">
          <div className="settings-section">
            <div className="settings-section-title">
              <Network size={18} />
              <div>
                <h2>控制服务连接</h2>
                <p>
                  HTTPS 通过当前站点的 /api 路由连接；局域网 HTTP
                  默认连接当前主机名的 4317 端口。
                </p>
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
              <dt>网页访问</dt>
              <dd>免令牌 · 记录用户名</dd>
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

function mergeUniqueFiles(current: File[], incoming: File[]) {
  const known = new Set(
    current.map(
      (file) => `${file.name}:${file.size}:${file.lastModified}:${file.type}`,
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
}

function clipboardImages(event: ReactClipboardEvent<HTMLTextAreaElement>) {
  const timestamp = Date.now();
  return Array.from(event.clipboardData.items)
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
}

function DefectThumbnail({ imageUrls }: { imageUrls: string[] }) {
  const [failedUrls, setFailedUrls] = useState<Set<string>>(() => new Set());

  const imageUrl = imageUrls.find((item) => !failedUrls.has(item));
  return (
    <span className="defect-thumbnails">
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt=""
          referrerPolicy="no-referrer"
          onError={() =>
            setFailedUrls((current) => new Set(current).add(imageUrl))
          }
        />
      ) : (
        <span className="defect-no-image">
          <FileText size={18} />
        </span>
      )}
    </span>
  );
}

function DefectImageGallery({ imageUrls }: { imageUrls: string[] }) {
  const [failedUrls, setFailedUrls] = useState<Set<string>>(() => new Set());

  const visibleImages = imageUrls.filter((item) => !failedUrls.has(item));
  if (!visibleImages.length) return null;
  return (
    <div className="defect-detail-images">
      {visibleImages.map((imageUrl, index) => (
        <a key={imageUrl} href={imageUrl} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt={`缺陷图片 ${index + 1}`}
            referrerPolicy="no-referrer"
            onError={() =>
              setFailedUrls((current) => new Set(current).add(imageUrl))
            }
          />
        </a>
      ))}
    </div>
  );
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
  onBatchSubmit,
}: {
  projects: Project[];
  workers: Worker[];
  turns: Turn[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>, files: File[]) => Promise<void>;
  onBatchSubmit: (
    payload: Record<string, unknown>,
    items: ProjectManagementBatchItem[],
  ) => Promise<ProjectManagementImportResult>;
}) {
  const dialogRef = useDialogFocusTrap(onClose);
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [idempotencyKey] = useState(createIdempotencyKey);
  const [requirement, setRequirement] = useState("");
  const [priority, setPriority] = useState(0);
  const [autoRelease, setAutoRelease] = useState(true);
  const [codexModel, setCodexModel] = useState("gpt-5.6-sol");
  const [codexReasoningEffort, setCodexReasoningEffort] = useState("xhigh");
  const [codexFastMode, setCodexFastMode] = useState(false);
  const [executionProfile, setExecutionProfile] =
    useState<ExecutionProfile>("auto");
  const [files, setFiles] = useState<File[]>([]);
  const [projectManagementSession, setProjectManagementSession] =
    useState<ProjectManagementSession | null>(null);
  const [projectManagementProjects, setProjectManagementProjects] = useState<
    ProjectManagementProject[]
  >([]);
  const [externalProjectId, setExternalProjectId] = useState("");
  const [defects, setDefects] = useState<ProjectManagementDefect[]>([]);
  const [defectTotal, setDefectTotal] = useState(0);
  const [defectSearch, setDefectSearch] = useState("");
  const [selectedDefects, setSelectedDefects] = useState<Set<string>>(
    () => new Set(),
  );
  const [defectDrafts, setDefectDrafts] = useState<
    Record<string, ProjectManagementDraft>
  >({});
  const [detailDefect, setDetailDefect] =
    useState<ProjectManagementDefect | null>(null);
  const [projectManagementLoading, setProjectManagementLoading] =
    useState(false);
  const [projectManagementLoginBusy, setProjectManagementLoginBusy] =
    useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [projectManagementError, setProjectManagementError] = useState("");
  const projectManagementInitialized = useRef(false);
  const projectManagementPolling = useRef(false);
  const project = projects[0];
  const selectedCodexModel =
    CODEX_MODEL_OPTIONS.find((option) => option.value === codexModel) ??
    CODEX_MODEL_OPTIONS[0];
  const availableReasoningOptions = CODEX_REASONING_OPTIONS.filter((option) =>
    selectedCodexModel.efforts.some((effort) => effort === option.value),
  );

  const addFiles = (incoming: File[]) => {
    setFiles((current) => mergeUniqueFiles(current, incoming));
  };

  const updateDefectDraft = useCallback(
    (
      defectId: string,
      update: (current: ProjectManagementDraft) => ProjectManagementDraft,
    ) => {
      setDefectDrafts((current) => ({
        ...current,
        [defectId]: update(current[defectId] ?? { extraPrompt: "", files: [] }),
      }));
    },
    [],
  );

  const pasteImages = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const images = clipboardImages(event);
    if (images.length) addFiles(images);
  };

  const startProjectManagementLogin = useCallback(async () => {
    setProjectManagementLoginBusy(true);
    setProjectManagementError("");
    try {
      const payload = await api<{ session: ProjectManagementSession }>(
        "/api/project-management/login/start",
        { method: "POST" },
      );
      setProjectManagementSession(payload.session);
    } catch (error) {
      setProjectManagementError(
        error instanceof Error ? error.message : "二维码生成失败，请重试",
      );
    } finally {
      setProjectManagementLoginBusy(false);
    }
  }, []);

  const loadProjectManagementProjects = useCallback(async () => {
    if (!project) return;
    setProjectManagementLoading(true);
    setProjectManagementError("");
    try {
      const payload = await api<{
        projects: ProjectManagementProject[];
        selectedProjectId?: string | null;
      }>(
        `/api/project-management/projects?relayProjectId=${encodeURIComponent(project.id)}`,
      );
      setProjectManagementProjects(payload.projects ?? []);
      setExternalProjectId(
        payload.selectedProjectId ||
          (payload.projects?.length === 1 ? payload.projects[0].id : ""),
      );
      if (!payload.projects?.length) {
        setProjectManagementError("当前账号没有可访问的项目");
      }
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 401) {
        setProjectManagementSession({ authenticated: false, login: null });
        await startProjectManagementLogin();
      } else {
        setProjectManagementError(
          error instanceof Error ? error.message : "读取项目列表失败",
        );
      }
    } finally {
      setProjectManagementLoading(false);
    }
  }, [project, startProjectManagementLogin]);

  const initializeProjectManagement = useCallback(async () => {
    setProjectManagementLoading(true);
    setProjectManagementError("");
    try {
      const payload = await api<{ session: ProjectManagementSession }>(
        "/api/project-management/session",
      );
      setProjectManagementSession(payload.session);
      if (payload.session.authenticated) {
        await loadProjectManagementProjects();
      } else {
        await startProjectManagementLogin();
      }
    } catch (error) {
      setProjectManagementError(
        error instanceof Error ? error.message : "连接项目管理系统失败",
      );
    } finally {
      setProjectManagementLoading(false);
    }
  }, [loadProjectManagementProjects, startProjectManagementLogin]);

  const loadDefects = useCallback(async () => {
    if (!project || !externalProjectId) return;
    setProjectManagementLoading(true);
    setProjectManagementError("");
    try {
      const payload = await api<{
        defects: ProjectManagementDefect[];
        total: number;
      }>(
        `/api/project-management/defects?relayProjectId=${encodeURIComponent(project.id)}&externalProjectId=${encodeURIComponent(externalProjectId)}&pageSize=200`,
      );
      const nextDefects = payload.defects ?? [];
      setDefects(nextDefects);
      setDefectTotal(payload.total ?? nextDefects.length);
      setSelectedDefects((current) => {
        const selectable = new Set(
          nextDefects
            .filter((defect) => !defect.importedTask)
            .map((defect) => defect.id),
        );
        return new Set([...current].filter((id) => selectable.has(id)));
      });
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 401) {
        setProjectManagementSession({ authenticated: false, login: null });
        setDefects([]);
        await startProjectManagementLogin();
      } else {
        setProjectManagementError(
          error instanceof Error ? error.message : "读取缺陷列表失败",
        );
      }
    } finally {
      setProjectManagementLoading(false);
    }
  }, [externalProjectId, project, startProjectManagementLogin]);

  useEffect(() => {
    if (mode !== "batch" || projectManagementInitialized.current) return;
    projectManagementInitialized.current = true;
    void initializeProjectManagement();
  }, [initializeProjectManagement, mode]);

  useEffect(() => {
    if (
      mode !== "batch" ||
      !projectManagementSession?.login ||
      !["pending", "scanned"].includes(projectManagementSession.login.status)
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      if (projectManagementPolling.current) return;
      projectManagementPolling.current = true;
      void api<{ session: ProjectManagementSession }>(
        "/api/project-management/login/status",
      )
        .then(async (payload) => {
          setProjectManagementSession(payload.session);
          if (payload.session.authenticated) {
            await loadProjectManagementProjects();
          }
        })
        .catch((error) => {
          setProjectManagementError(
            error instanceof Error ? error.message : "扫码状态读取失败",
          );
        })
        .finally(() => {
          projectManagementPolling.current = false;
        });
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [loadProjectManagementProjects, mode, projectManagementSession?.login]);

  useEffect(() => {
    if (
      mode === "batch" &&
      projectManagementSession?.authenticated &&
      externalProjectId
    ) {
      const timer = window.setTimeout(() => void loadDefects(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [
    externalProjectId,
    loadDefects,
    mode,
    projectManagementSession?.authenticated,
  ]);

  const visibleDefects = useMemo(() => {
    const query = defectSearch.trim().toLowerCase();
    if (!query) return defects;
    return defects.filter((defect) =>
      `${defect.code || ""} ${defect.title} ${defect.content} ${defect.status || ""}`
        .toLowerCase()
        .includes(query),
    );
  }, [defectSearch, defects]);

  const selectableVisibleDefects = visibleDefects.filter(
    (defect) => !defect.importedTask,
  );
  const allVisibleSelected =
    selectableVisibleDefects.length > 0 &&
    selectableVisibleDefects.every((defect) => selectedDefects.has(defect.id));

  const openDefectDetail = async (defect: ProjectManagementDefect) => {
    if (!project || !externalProjectId) return;
    setDetailDefect(defect);
    setDetailLoading(true);
    setProjectManagementError("");
    try {
      const payload = await api<{ defect: ProjectManagementDefect }>(
        `/api/project-management/defects/${encodeURIComponent(defect.id)}?relayProjectId=${encodeURIComponent(project.id)}&externalProjectId=${encodeURIComponent(externalProjectId)}`,
      );
      setDetailDefect(payload.defect);
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 401) {
        setDetailDefect(null);
        setProjectManagementSession({ authenticated: false, login: null });
        await startProjectManagementLogin();
      } else {
        setProjectManagementError(
          error instanceof Error ? error.message : "读取缺陷详情失败",
        );
      }
    } finally {
      setDetailLoading(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!project) return;
    if (mode === "single") {
      if (!requirement.trim()) return;
      await onSubmit(
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
          executionProfile,
          idempotencyKey,
        },
        files,
      );
      return;
    }
    if (!externalProjectId || selectedDefects.size === 0) return;
    setProjectManagementError("");
    try {
      const result = await onBatchSubmit(
        {
          projectId: project.id,
          externalProjectId,
          baseBranch: project.defaultBranch,
          priority,
          autoRelease,
          codexModel,
          codexReasoningEffort,
          codexFastMode,
          executionProfile,
        },
        [...selectedDefects].map((defectId) => ({
          defectId,
          extraPrompt: defectDrafts[defectId]?.extraPrompt || "",
          files: defectDrafts[defectId]?.files || [],
        })),
      );
      if (result.failed > 0) {
        const failedMessages = result.results
          .filter((item) => item.status === "failed")
          .map(
            (item) => item.error?.message || `缺陷 ${item.defectId} 创建失败`,
          );
        setProjectManagementError(failedMessages.join("；"));
        await loadDefects();
      }
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 401) {
        setProjectManagementSession({ authenticated: false, login: null });
        await startProjectManagementLogin();
      } else {
        setProjectManagementError(
          error instanceof Error ? error.message : "批量创建任务失败",
        );
      }
    }
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        ref={dialogRef}
        className={cx(
          "modal task-create-modal",
          mode === "batch" && "batch-mode",
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
        aria-describedby="new-task-description"
        onSubmit={submit}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">NEW PERSISTENT TASK</span>
            <div
              className="task-create-tabs"
              role="tablist"
              aria-label="任务创建方式"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === "single"}
                className={mode === "single" ? "active" : undefined}
                onClick={() => setMode("single")}
              >
                <FileText size={15} />
                单独创建
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "batch"}
                className={mode === "batch" ? "active" : undefined}
                onClick={() => setMode("batch")}
              >
                <ListChecks size={15} />
                列表创建
              </button>
            </div>
            <h2 id="new-task-title">发起新任务</h2>
            <p id="new-task-description">
              {mode === "single"
                ? "系统会创建专属分支、Codex 对话和第一个执行轮次。"
                : "勾选项目管理缺陷；每个缺陷都会创建独立分支和执行任务。"}
            </p>
          </div>
          <IconButton label="关闭" type="button" onClick={onClose}>
            <X size={19} />
          </IconButton>
        </div>
        {projects.length ? (
          <>
            {mode === "single" ? (
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
                            current.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          )
                        }
                      />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <section className="defect-picker" aria-label="项目管理缺陷列表">
                {!projectManagementSession?.authenticated ? (
                  <div className="project-management-login">
                    <div className="project-management-login-icon">
                      <ScanLine size={24} />
                    </div>
                    <div>
                      <h3>扫码读取分配给我的缺陷</h3>
                      <p>
                        当前 Relay 用户：
                        <strong>
                          {projectManagementSession?.relayUserName ||
                            "未记录用户"}
                        </strong>
                        。使用轻羽 APP 扫码后只绑定到该用户，不会修改原单状态。
                      </p>
                    </div>
                    {projectManagementSession?.login?.qrContent ? (
                      <div className="project-management-qr">
                        <QRCodeSVG
                          value={projectManagementSession.login.qrContent}
                          size={184}
                          level="M"
                          marginSize={2}
                        />
                        <strong>
                          {projectManagementSession.login.status === "scanned"
                            ? "已扫码，请在手机确认"
                            : ["expired", "cancelled"].includes(
                                  projectManagementSession.login.status,
                                )
                              ? "二维码已失效"
                              : "二维码有效期 5 分钟"}
                        </strong>
                        {["expired", "cancelled", "error"].includes(
                          projectManagementSession.login.status,
                        ) && (
                          <button
                            type="button"
                            className="secondary-action"
                            onClick={() => void startProjectManagementLogin()}
                            disabled={projectManagementLoginBusy}
                          >
                            <RefreshCw size={15} />
                            重新生成
                          </button>
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="primary-action"
                        onClick={() => void startProjectManagementLogin()}
                        disabled={projectManagementLoginBusy}
                      >
                        {projectManagementLoginBusy ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <ScanLine size={16} />
                        )}
                        生成登录二维码
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="defect-picker-toolbar">
                      <div className="defect-picker-account">
                        <span className="status-dot healthy" />
                        <div>
                          <strong>
                            {projectManagementSession.user?.name || "已登录"}
                          </strong>
                          <small>
                            绑定 Relay：
                            {projectManagementSession.relayUserName ||
                              "未记录用户"}
                            · 只显示分配给我的未结束缺陷
                          </small>
                        </div>
                      </div>
                      {projectManagementProjects.length > 1 && (
                        <label className="defect-project-select">
                          <span>项目</span>
                          <select
                            value={externalProjectId}
                            onChange={(event) => {
                              setExternalProjectId(event.target.value);
                              setSelectedDefects(new Set());
                            }}
                          >
                            <option value="">请选择项目</option>
                            {projectManagementProjects.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label className="defect-search">
                        <Search size={15} />
                        <input
                          value={defectSearch}
                          onChange={(event) =>
                            setDefectSearch(event.target.value)
                          }
                          placeholder="搜索编号、标题或内容"
                        />
                      </label>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="刷新缺陷列表"
                        onClick={() => void loadDefects()}
                        disabled={
                          projectManagementLoading || !externalProjectId
                        }
                      >
                        <RefreshCw
                          className={
                            projectManagementLoading ? "spin" : undefined
                          }
                          size={16}
                        />
                      </button>
                    </div>
                    <div className="defect-picker-summary">
                      <label>
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={(event) => {
                            const next = new Set(selectedDefects);
                            for (const defect of selectableVisibleDefects) {
                              if (event.target.checked) next.add(defect.id);
                              else next.delete(defect.id);
                            }
                            setSelectedDefects(next);
                          }}
                          disabled={!selectableVisibleDefects.length}
                        />
                        选择当前列表
                      </label>
                      <span>
                        已选 <strong>{selectedDefects.size}</strong> 个 · 共读取{" "}
                        {defectTotal} 个
                      </span>
                    </div>
                    <div
                      className="defect-list"
                      aria-busy={projectManagementLoading}
                    >
                      {projectManagementLoading && defects.length === 0 ? (
                        <div className="defect-list-state">
                          <LoaderCircle className="spin" size={22} />
                          正在读取缺陷列表…
                        </div>
                      ) : visibleDefects.length === 0 ? (
                        <div className="defect-list-state">
                          <Inbox size={24} />
                          {externalProjectId
                            ? "没有找到分配给你的缺陷"
                            : "请先选择项目"}
                        </div>
                      ) : (
                        visibleDefects.map((defect) => {
                          const draft = defectDrafts[defect.id];
                          const selected = selectedDefects.has(defect.id);
                          return (
                            <article
                              key={defect.id}
                              className={cx(
                                "defect-card",
                                selected && "selected",
                                defect.importedTask && "imported",
                              )}
                            >
                              <label className="defect-checkbox">
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  disabled={Boolean(defect.importedTask)}
                                  onChange={(event) => {
                                    const next = new Set(selectedDefects);
                                    if (event.target.checked)
                                      next.add(defect.id);
                                    else next.delete(defect.id);
                                    setSelectedDefects(next);
                                  }}
                                />
                                <span />
                              </label>
                              <button
                                type="button"
                                className="defect-card-main"
                                onClick={() => void openDefectDetail(defect)}
                              >
                                <span className="defect-card-copy">
                                  <span className="defect-card-title-row">
                                    {defect.code && <code>{defect.code}</code>}
                                    <strong>{defect.title}</strong>
                                  </span>
                                  <span className="defect-card-content">
                                    {defect.content}
                                  </span>
                                  <span className="defect-card-meta">
                                    {defect.status && (
                                      <span>{defect.status}</span>
                                    )}
                                    {defect.priority && (
                                      <span>{defect.priority}</span>
                                    )}
                                    {defect.severity && (
                                      <span>{defect.severity}</span>
                                    )}
                                    {(draft?.extraPrompt ||
                                      draft?.files.length) && (
                                      <span className="supplemented">
                                        已补充提示词/图片
                                      </span>
                                    )}
                                    {defect.importedTask && (
                                      <span className="already-imported">
                                        已创建 TK-
                                        {String(
                                          defect.importedTask.number,
                                        ).padStart(4, "0")}
                                      </span>
                                    )}
                                  </span>
                                </span>
                                <DefectThumbnail
                                  key={defect.images.join("\u001f")}
                                  imageUrls={defect.images}
                                />
                                <ChevronRight size={17} />
                              </button>
                            </article>
                          );
                        })
                      )}
                    </div>
                  </>
                )}
                {projectManagementError && (
                  <div className="defect-picker-error" role="alert">
                    <AlertTriangle size={16} />
                    <span>{projectManagementError}</span>
                    {projectManagementSession?.authenticated && (
                      <button type="button" onClick={() => void loadDefects()}>
                        重试
                      </button>
                    )}
                  </div>
                )}
              </section>
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
                  <p>模型设置沿用到后续轮次；执行路线可在每一轮单独调整。</p>
                </div>
              </div>
              <div className="codex-task-settings-grid">
                <StyledSelect
                  label="首轮执行路线"
                  value={executionProfile}
                  options={EXECUTION_PROFILE_OPTIONS}
                  description={
                    EXECUTION_PROFILE_OPTIONS.find(
                      (option) => option.value === executionProfile,
                    )?.detail
                  }
                  onChange={(value) =>
                    setExecutionProfile(value as ExecutionProfile)
                  }
                />
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
                {mode === "single"
                  ? "需求文本不会进入 PowerShell 命令"
                  : `每个缺陷独立创建任务 · 已选 ${selectedDefects.size} 个`}
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
                disabled={
                  busy ||
                  (mode === "single"
                    ? !requirement.trim()
                    : !externalProjectId || selectedDefects.size === 0)
                }
              >
                {busy ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <ArrowRight size={17} />
                )}
                {mode === "single"
                  ? "加入执行队列"
                  : `一键批量开始${selectedDefects.size ? `（${selectedDefects.size}）` : ""}`}
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
        {detailDefect && (
          <div
            className="defect-detail-backdrop"
            onMouseDown={(event) =>
              event.target === event.currentTarget && setDetailDefect(null)
            }
          >
            <section
              className="defect-detail-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby="defect-detail-title"
            >
              <div className="defect-detail-head">
                <div>
                  <span>{detailDefect.code || `缺陷 ${detailDefect.id}`}</span>
                  <h3 id="defect-detail-title">{detailDefect.title}</h3>
                </div>
                <IconButton
                  type="button"
                  label="关闭缺陷详情"
                  onClick={() => setDetailDefect(null)}
                >
                  <X size={18} />
                </IconButton>
              </div>
              <div className="defect-detail-scroll">
                {detailLoading && (
                  <div className="defect-detail-loading">
                    <LoaderCircle className="spin" size={18} />
                    正在读取完整信息…
                  </div>
                )}
                <dl className="defect-detail-facts">
                  <div>
                    <dt>状态</dt>
                    <dd>{detailDefect.status || "未填写"}</dd>
                  </div>
                  <div>
                    <dt>优先级</dt>
                    <dd>{detailDefect.priority || "未填写"}</dd>
                  </div>
                  <div>
                    <dt>严重程度</dt>
                    <dd>{detailDefect.severity || "未填写"}</dd>
                  </div>
                  <div>
                    <dt>负责人</dt>
                    <dd>{detailDefect.assignee || "未填写"}</dd>
                  </div>
                </dl>
                <div className="defect-detail-content">
                  <div>
                    <h4>完整缺陷内容</h4>
                    <a href={detailDefect.url} target="_blank" rel="noreferrer">
                      打开原始缺陷
                      <ExternalLink size={13} />
                    </a>
                  </div>
                  <p>{detailDefect.content}</p>
                </div>
                <DefectImageGallery
                  key={detailDefect.images.join("\u001f")}
                  imageUrls={detailDefect.images}
                />
                {!detailDefect.importedTask && (
                  <div className="defect-supplement">
                    <div>
                      <h4>补充给 Codex 的信息</h4>
                      <p>只会附加到这一个缺陷任务，可继续粘贴截图。</p>
                    </div>
                    <textarea
                      value={defectDrafts[detailDefect.id]?.extraPrompt || ""}
                      onChange={(event) =>
                        updateDefectDraft(detailDefect.id, (current) => ({
                          ...current,
                          extraPrompt: event.target.value,
                        }))
                      }
                      onPaste={(event) => {
                        const images = clipboardImages(event);
                        if (!images.length) return;
                        updateDefectDraft(detailDefect.id, (current) => ({
                          ...current,
                          files: mergeUniqueFiles(current.files, images),
                        }));
                      }}
                      rows={5}
                      placeholder="补充复现条件、期望效果、技术方向或验收标准…"
                    />
                    <div className="attachment-actions">
                      <label className="attachment-button">
                        <ImagePlus size={17} />
                        补充图片或文件
                        <input
                          type="file"
                          multiple
                          onChange={(event) => {
                            const incoming = Array.from(
                              event.target.files ?? [],
                            );
                            updateDefectDraft(detailDefect.id, (current) => ({
                              ...current,
                              files: mergeUniqueFiles(current.files, incoming),
                            }));
                            event.currentTarget.value = "";
                          }}
                        />
                      </label>
                      <span>也可以在上面的输入框直接粘贴截图</span>
                    </div>
                    {(defectDrafts[detailDefect.id]?.files.length ?? 0) > 0 && (
                      <div className="attachment-list">
                        {defectDrafts[detailDefect.id].files.map(
                          (file, index) => (
                            <AttachmentChip
                              key={`${file.name}:${file.size}:${file.lastModified}:${index}`}
                              file={file}
                              onRemove={() =>
                                updateDefectDraft(
                                  detailDefect.id,
                                  (current) => ({
                                    ...current,
                                    files: current.files.filter(
                                      (_, itemIndex) => itemIndex !== index,
                                    ),
                                  }),
                                )
                              }
                            />
                          ),
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="defect-detail-actions">
                {!detailDefect.importedTask && (
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedDefects.has(detailDefect.id)}
                      onChange={(event) => {
                        const next = new Set(selectedDefects);
                        if (event.target.checked) next.add(detailDefect.id);
                        else next.delete(detailDefect.id);
                        setSelectedDefects(next);
                      }}
                    />
                    加入本次批量任务
                  </label>
                )}
                <button
                  type="button"
                  className="primary-action"
                  onClick={() => setDetailDefect(null)}
                >
                  <Check size={16} />
                  完成
                </button>
              </div>
            </section>
          </div>
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
    unitySaveUrl: project?.unitySaveUrl ?? "http://{internalIp}:8090/api/save",
    checkpointName: project?.checkpointName ?? "PROJECT_READY",
    enabled: project?.enabled ?? true,
    autoBuildEnabled: project?.autoBuildEnabled ?? false,
    buildProjectKey: project?.buildProjectKey ?? "ozdqp",
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
            <span>构建项目 Key</span>
            <input
              value={form.buildProjectKey}
              onChange={(event) => set("buildProjectKey", event.target.value)}
              placeholder="ozdqp"
              disabled={!form.autoBuildEnabled}
            />
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={form.autoBuildEnabled}
              onChange={(event) =>
                set("autoBuildEnabled", event.target.checked)
              }
            />
            <span>
              <strong>交付后自动构建 Windows CDN</strong>
              <small>仅远程完整 SHA 已核验时写入事务性队列</small>
            </span>
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

function IdentityDialog({
  currentName,
  canClose,
  onClose,
  onSave,
}: {
  currentName: string;
  canClose: boolean;
  onClose: () => void;
  onSave: (value: string) => void;
}) {
  const dialogRef = useDialogFocusTrap(canClose ? onClose : () => {});
  const [name, setName] = useState(currentName);
  const normalizedName = name.trim().replace(/\s+/gu, " ").slice(0, 80);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (normalizedName) onSave(normalizedName);
  };
  return (
    <div className="modal-backdrop identity-backdrop">
      <form
        ref={dialogRef}
        className="modal identity-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="identity-title"
        aria-describedby="identity-description"
        onSubmit={submit}
      >
        <span className="identity-mark">
          <Layers3 size={24} />
        </span>
        <span className="eyebrow">RELAY USER</span>
        <h2 id="identity-title">输入使用者名称</h2>
        <p id="identity-description">
          无需访问令牌或密码。这个名称只用于区分任务发起人、消息作者和审计操作。
        </p>
        <label className="form-field">
          <span>你的名称</span>
          <input
            autoFocus
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：Lin、产品组小王"
            autoComplete="name"
          />
        </label>
        <div className="modal-actions">
          <span>名称会保存在当前浏览器中，可随时切换。</span>
          {canClose && (
            <button
              type="button"
              className="secondary-action"
              onClick={onClose}
            >
              返回
            </button>
          )}
          <button className="primary-action" disabled={!normalizedName}>
            进入调度台
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
