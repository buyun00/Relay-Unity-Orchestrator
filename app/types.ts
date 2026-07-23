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
  level: "info" | "success" | "warning" | "error";
  type: string;
  phase?: string | null;
  message: string;
  data?: Record<string, unknown> | null;
  createdAt: string;
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
    requiresAuth?: boolean;
    runtime?: HostRuntime | null;
  };
  projects: Project[];
  workers: Worker[];
  tasks: Task[];
  turns: Turn[];
  events: PipelineEvent[];
}

export const EMPTY_SNAPSHOT: Snapshot = {
  server: { mode: "hyperv", connected: false, schedulerRunning: false },
  projects: [],
  workers: [],
  tasks: [],
  turns: [],
  events: [],
};
