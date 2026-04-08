/**
 * Agent Cluster shared type definitions.
 */

// ── Event types ──

export interface EventEntry {
  seq: number;
  timestamp: number;
  type: ClusterEventType;
  sourceWorkerId: string;
  targetWorkerId?: string;
  data: Record<string, unknown>;
  jobId?: string;
  taskId?: string;
}

export type ClusterEventType =
  | 'file_changed'
  | 'task_completed'
  | 'task_failed'
  | 'directive'
  | 'answer'
  | 'lock_released'
  | 'lock_acquired'
  | 'worker_joined'
  | 'worker_left'
  | 'message'
  | 'help_request';

// ── Worker types ──

export type WorkerRole = 'coder' | 'planner' | 'reviewer' | 'custom';
export type WorkerStatus = 'starting' | 'running' | 'idle' | 'stopping' | 'exited';

export interface WorkerRegistration {
  workerId: string;
  role: WorkerRole;
  project: string;
  templateName: string;
  status: 'active' | 'idle' | 'exited';
  currentTaskId?: string;
  lastSeen: number;
  syncCursor: number;
  stats: {
    tasksCompleted: number;
    tasksFailed: number;
    totalReports: number;
    registeredAt: number;
  };
}

export interface WorkerInstance {
  id: string;
  templateName: string;
  project: string;
  process: import('bun').Subprocess | null;
  status: WorkerStatus;
  currentTask: TaskRecord | null;
  startedAt: number;
  lastReport: number;
}

// ── Task / Job types ──

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskStatus = 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'blocked';
export type TaskSourceType = 'todo-file' | 'queue' | 'planner';

export interface JobRecord {
  id: string;
  project: string;
  description: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  taskCount: number;
  tasksCompleted: number;
  tasksFailed: number;
  metadata?: string;
}

export interface TaskRecord {
  id: string;
  jobId: string;
  project: string;
  description: string;
  status: TaskStatus;
  workerId?: string;
  workerTemplate?: string;
  source: TaskSourceType;
  createdAt: string;
  claimedAt?: string;
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  filesModified?: string;
  diffSummary?: string;
  metadata?: string;
}

export interface TaskCandidate {
  description: string;
  source: TaskSourceType;
  project: string;
  files?: string[];
  priority?: number;
  metadata?: Record<string, unknown>;
}

// ── Lock types ──

export interface FileLock {
  filePath: string;
  workerId: string;
  taskId?: string;
  claimedAt: number;
  lastRenewed: number;
  ttl: number;
}

export interface LockConflict {
  file: string;
  heldBy: string;
  since: number;
  estimatedRelease?: number;
}

// ── Help request types ──

export type HelpRequestType = 'clarification' | 'decision' | 'conflict' | 'escalation';
export type HelpRequestStatus = 'pending' | 'answered' | 'expired';

export interface HelpRequest {
  id: string;
  workerId: string;
  taskId?: string;
  type: HelpRequestType;
  question: string;
  context?: string;
  options?: string[];
  status: HelpRequestStatus;
  answer?: string;
  answeredBy?: string;
  createdAt: string;
  answeredAt?: string;
}

// ── MCP Tool I/O types ──

export interface HubSyncOutput {
  updates: HubUpdate[];
  cluster: {
    activeWorkers: number;
    pendingTasks: number;
    myPendingMessages: number;
  };
}

export interface HubUpdate {
  type: ClusterEventType;
  from: string;
  summary: string;
  data?: Record<string, unknown>;
}

export interface HubClaimInput {
  taskId: string;
  intent: string;
  files: string[];
}

export interface HubClaimOutput {
  granted: boolean;
  conflicts?: LockConflict[];
  suggestion?: string;
}

export interface HubReportInput {
  status: 'working' | 'completed' | 'failed' | 'blocked';
  summary: string;
  filesModified?: string[];
  detail?: {
    linesAdded?: number;
    linesRemoved?: number;
    testsRan?: number;
    testsPassed?: number;
    error?: string;
    blockReason?: string;
  };
}

export interface HubReportOutput {
  ack: true;
  directives?: string[];
}

export interface HubAskInput {
  type: HelpRequestType;
  question: string;
  context?: string;
  options?: string[];
}

export interface HubAskOutput {
  received: true;
  askId: string;
  expectedResponseTime?: string;
}

export interface HubMessageInput {
  to: string;
  content: string;
  priority: 'info' | 'warning';
}

export interface HubMessageOutput {
  delivered: true;
}

// ── Planner-only MCP Tool I/O types ──

export interface HubDispatchInput {
  project: string;
  taskDescription: string;
  files: string[];
  workerTemplate?: string;
  priority?: number;
}

export interface HubDirectiveInput {
  to: string;
  content: string;
}

// ── Worker Backend types ──

export interface WorkerSpawnConfig {
  workerId: string;
  taskPrompt: string;
  projectPath: string;
  mcpConfigPath: string;
  env: Record<string, string>;
  timeout: number;
}

export interface WorkerBackend {
  name: string;
  spawn(config: WorkerSpawnConfig): Promise<import('bun').Subprocess>;
}

// ── Cluster status ──

export interface ClusterStatus {
  running: boolean;
  paused: boolean;
  activeWorkers: number;
  idleWorkers: number;
  pendingTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  workers: Array<{
    id: string;
    template: string;
    project: string;
    status: WorkerStatus;
    currentTaskDescription?: string;
    uptime: number;
  }>;
}
