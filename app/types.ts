export type ServiceMode = "hyperv";

export type WorkerStatus =
  | "ready"
  | "busy"
  | "preparing"
  | "reserved"
  | "offline"
  | "stopped"
  | "restarting";

export type TaskStatus =
  | "queued"
  | "running"
  | "recovering"
  | "waiting_user"
  | "waiting_review"
  | "needs_attention"
  | "closed"
  | "cancelled";

export type TurnStatus =
  | "queued"
  | "preparing"
  | "running"
  | "saving"
  | "success"
  | "failed"
  | "cancelled"
  | "interrupted";

export type HealthState = "healthy" | "warning" | "error" | "unknown";

export interface HealthMap {
  vm: HealthState;
  heartbeat: HealthState;
  smb: HealthState;
  unity: HealthState;
  skill: HealthState;
  dialogGuard: HealthState;
}

export interface Project {
  id: string;
  name: string;
  slug?: string;
  repoUrl: string;
  defaultBranch: string;
  guestProjectPath: string;
  smbPath: string;
  unityVersion: string;
  unitySkillPort: number;
  unitySkillUrl?: string | null;
  unityHealthUrl?: string | null;
  unitySaveUrl?: string | null;
  checkpointName: string;
  enabled: boolean;
  autoBuildEnabled: boolean;
  buildProjectKey?: string | null;
  compatibleWorkerIds?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectManagementUser {
  id: string;
  name: string;
  avatar?: string | null;
}

export interface ProjectManagementSession {
  authenticated: boolean;
  relayUserName?: string | null;
  user?: ProjectManagementUser | null;
  login?: {
    status:
      "pending" | "scanned" | "confirmed" | "expired" | "cancelled" | "error";
    qrContent: string;
    expiresAt: string;
  } | null;
}

export interface ProjectManagementProject {
  id: string;
  name: string;
}

export interface ProjectManagementImportedTask {
  id: string;
  number: number | string;
  status: TaskStatus;
  title: string;
}

export interface ProjectManagementDefect {
  id: string;
  code?: string | null;
  title: string;
  content: string;
  status?: string | null;
  statusKey?: string | null;
  priority?: string | null;
  severity?: string | null;
  assignee?: string | null;
  updatedAt?: string | null;
  images: string[];
  url: string;
  importedTask?: ProjectManagementImportedTask | null;
}

export interface BuildDispatch {
  id: string;
  turnId: string;
  turnSequence: number;
  taskId: string;
  projectId: string;
  projectKey: string;
  repositoryUrl: string;
  branchName: string;
  commitSha: string;
  buildType: "cdn";
  modules: string[];
  playerBaseVersion: number;
  idempotencyKey: string;
  status: "pending" | "sending" | "retrying" | "accepted" | "failed";
  attemptCount: number;
  nextAttemptAt: string;
  ozdqpJobId?: string | null;
  lastHttpStatus?: number | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
  acceptedAt?: string | null;
  failedAt?: string | null;
  buildStatus?:
    | "queued"
    | "preparing"
    | "building"
    | "validating"
    | "publishing"
    | "completed"
    | "failed"
    | "unknown"
    | string
    | null;
  buildStep?: string | null;
  buildCdnUrl?: string | null;
  buildErrorMessage?: string | null;
  buildStartedAt?: string | null;
  buildFinishedAt?: string | null;
  buildDurationSeconds?: number | null;
  statusCheckedAt?: string | null;
  nextStatusCheckAt?: string | null;
  statusCheckAttemptCount: number;
  statusCheckErrorCode?: string | null;
  statusCheckErrorMessage?: string | null;
}

export interface Worker {
  id: string;
  name: string;
  vmName: string;
  status: WorkerStatus;
  enabled: boolean;
  projectIds: string[];
  projectId?: string | null;
  currentTurnId?: string | null;
  internalIp?: string;
  corporateIp?: string;
  smbPath?: string;
  sharePath?: string;
  checkpointName?: string;
  credentialPath?: string;
  health: HealthMap;
  lastSeenAt?: string;
  lastError?: string | null;
  progress?: number;
}

export interface TurnResult {
  status?: "completed" | "needs_input" | "blocked";
  summary?: string;
  changedFiles?: string[];
  validation?: string[];
  risks?: string[];
  question?: string | null;
  diff?: { additions: number; deletions: number };
  durationSeconds?: number;
}

export interface Attachment {
  id: string;
  filename: string;
  contentType?: string | null;
  size: number;
  createdAt: string;
}

export type ExecutionProfile = "auto" | "code_only" | "unity_asset";

export interface Turn {
  id: string;
  taskId: string;
  sequence: number;
  userMessage: string;
  authorName: string;
  attachments?: Attachment[];
  executionProfile?: ExecutionProfile;
  status: TurnStatus;
  phase?: string;
  workerId?: string | null;
  queuePosition?: number | null;
  codexFinal?: string | Record<string, unknown> | null;
  commitSha?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  result?: TurnResult | null;
  priority?: number;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface Task {
  id: string;
  number: string;
  title: string;
  createdBy: string;
  projectId: string;
  baseBranch: string;
  branchName: string;
  codexThreadId?: string | null;
  status: TaskStatus;
  latestCommitSha?: string | null;
  priority?: number;
  autoRelease?: boolean;
  codexModel: string;
  codexReasoningEffort: string;
  codexFastMode: boolean;
  projectManagement?: {
    externalProjectId?: string | null;
    defectId: string;
    defectUrl?: string | null;
    relayUserName?: string | null;
    userId?: string | null;
    userName?: string | null;
    resolvedAt?: string | null;
  } | null;
  completion?: {
    status: "idle" | "running" | "failed" | "completed";
    step?:
      "merge_request" | "project_management" | "relay" | "relay_only" | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    mergeRequestIid?: number | null;
    mergeRequestUrl?: string | null;
    mergedCommitSha?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  };
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
}

export interface PipelineEvent {
  id: number | string;
  taskId?: string | null;
  turnId?: string | null;
  workerId?: string | null;
  opsTurnId?: string | null;
  incidentId?: string | null;
  actorName?: string | null;
  level: "info" | "success" | "warning" | "error";
  type: string;
  phase?: string | null;
  message: string;
  data?: Record<string, unknown> | null;
  createdAt: string;
}

export interface OpsThread {
  id: string;
  title: string;
  isSystem: boolean;
  clearedThroughSequence: number;
  visibleTurnCount?: number;
  totalTurnCount?: number;
  codexThreadId?: string | null;
  status: string;
  codexModel: string;
  codexReasoningEffort: string;
  codexFastMode: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OpsTurn {
  id: string;
  threadId: string;
  sequence: number;
  trigger: "manual" | "incident" | "followup" | string;
  incidentId?: string | null;
  targetTaskId?: string | null;
  parentOpsTurnId?: string | null;
  userMessage: string;
  authorName: string;
  status: string;
  final?: {
    status?: string;
    summary?: string;
    diagnosis?: string;
    confidence?: number;
    verification?: string;
    actions?: Array<Record<string, unknown>>;
    actionResults?: Array<Record<string, unknown>>;
  } | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface Incident {
  id: string;
  fingerprint: string;
  status: string;
  severity: string;
  sourceEventId?: number | null;
  taskId?: string | null;
  turnId?: string | null;
  workerId?: string | null;
  title: string;
  error: string;
  context?: Record<string, unknown> | null;
  attemptCount: number;
  lastAction?: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | null;
}

export interface OpsAction {
  id: string;
  opsTurnId: string;
  incidentId?: string | null;
  type: string;
  targetId?: string | null;
  message?: string | null;
  reason?: string | null;
  status: string;
  reversible: boolean;
  result?: Record<string, unknown> | null;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface RepairRun {
  id: string;
  opsTurnId?: string | null;
  incidentId?: string | null;
  status: string;
  instructions: string;
  branchName?: string | null;
  worktreePath?: string | null;
  baseSha?: string | null;
  commitSha?: string | null;
  codexThreadId?: string | null;
  validation?: Array<Record<string, unknown>> | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
  deployedAt?: string | null;
  rolledBackAt?: string | null;
}

export interface HostVirtualMachine {
  id: string;
  name: string;
  state: string;
  status: string;
  generation: number;
  version: string;
  cpuUsage: number;
  memoryAssigned: number;
  uptime: string;
  heartbeat?: string | null;
  ipAddresses: string[];
}

export interface HostMetricsSnapshot {
  sampledAt: string;
  cacheAgeMs: number;
  cpu: {
    available: boolean;
    usagePercent: number | null;
    logicalProcessors: number;
    source: string;
  };
  memory: {
    available: boolean;
    usagePercent: number | null;
    totalBytes: number | null;
    usedBytes: number | null;
    source: string;
  };
  temperature: {
    available: boolean;
    celsius: number | null;
    sensor: string | null;
    kind: "cpu" | "system" | "gpu" | string | null;
    source: string | null;
  };
  gpu: {
    available: boolean;
    usagePercent: number | null;
    name: string | null;
    memoryUsedBytes: number | null;
    memoryTotalBytes: number | null;
    memoryUsagePercent: number | null;
    source: string | null;
  };
  disk: {
    available: boolean;
    usagePercent: number | null;
    capacityUsagePercent: number | null;
    metricKind: "activity" | "capacity";
    totalBytes: number | null;
    usedBytes: number | null;
    volumes: Array<{
      name: string;
      totalBytes: number;
      freeBytes: number;
      usedBytes: number;
      usagePercent: number | null;
    }>;
    source: string;
  };
  warning?: string | null;
}

export interface HostRuntime {
  ready: boolean;
  checkedAt: string;
  checkpointsEnabled: boolean;
  hyperv: {
    computerName?: string;
    moduleAvailable: boolean;
    canManage: boolean;
    elevated?: boolean;
    vmCount: number;
    virtualMachines?: HostVirtualMachine[];
    error?: string | null;
  };
  codex: {
    command?: string;
    home?: string | null;
    available: boolean;
    authenticated: boolean;
    version?: string | null;
    loginStatus?: string | null;
    error?: string | null;
  };
}

export interface Snapshot {
  server: {
    mode: ServiceMode;
    version?: string;
    connected?: boolean;
    startedAt?: string;
    schedulerRunning?: boolean;
    runtime?: HostRuntime | null;
    recoveryMode?: boolean;
    ops?: {
      enabled: boolean;
      running: boolean;
      activeTurnId?: string | null;
      activeTurnIds?: string[];
      activeSessions?: number;
      maxConcurrentSessions?: number;
      openIncidents?: number;
      automaticHandling?: boolean;
      automaticDeployment?: boolean;
      supervisor?: {
        running?: boolean;
        intervalMs?: number;
        model?: string;
        reasoningEffort?: string;
        repairModel?: string;
        repairReasoningEffort?: string;
        activeTaskCount?: number;
        lastCheckAt?: string | null;
        nextCheckAt?: string | null;
      };
    } | null;
    guardian?: {
      enabled?: boolean;
      reachable?: boolean;
      failures?: number;
      lastSeenAt?: string | null;
      port?: number;
      [key: string]: unknown;
    } | null;
  };
  projects: Project[];
  workers: Worker[];
  tasks: Task[];
  turns: Turn[];
  buildDispatches: BuildDispatch[];
  events: PipelineEvent[];
  ops: {
    thread: OpsThread;
    threads: OpsThread[];
    turns: OpsTurn[];
    incidents: Incident[];
    actions: OpsAction[];
    repairs: RepairRun[];
  };
}

export const EMPTY_SNAPSHOT: Snapshot = {
  server: { mode: "hyperv", connected: false, schedulerRunning: false },
  projects: [],
  workers: [],
  tasks: [],
  turns: [],
  buildDispatches: [],
  events: [],
  ops: {
    thread: {
      id: "ops-system",
      title: "系统自动恢复",
      isSystem: true,
      clearedThroughSequence: 0,
      codexThreadId: null,
      status: "idle",
      codexModel: "gpt-5.6-luna",
      codexReasoningEffort: "max",
      codexFastMode: false,
      createdAt: "",
      updatedAt: "",
    },
    threads: [],
    turns: [],
    incidents: [],
    actions: [],
    repairs: [],
  },
};
