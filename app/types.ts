export type ServiceMode = "hyperv";

export type WorkerStatus =
  | "ready"
  | "busy"
  | "preparing"
  | "reserved"
  | "attention"
  | "offline"
  | "stopped"
  | "restarting";

export type TaskStatus =
  | "queued"
  | "running"
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
  compatibleWorkerIds?: string[];
  createdAt?: string;
  updatedAt?: string;
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

export interface Turn {
  id: string;
  taskId: string;
  sequence: number;
  userMessage: string;
  authorName: string;
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
  events: [],
  ops: {
    thread: {
      id: "ops-system",
      title: "系统自动恢复",
      isSystem: true,
      clearedThroughSequence: 0,
      codexThreadId: null,
      status: "idle",
      codexModel: "gpt-5.6-sol",
      codexReasoningEffort: "xhigh",
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
