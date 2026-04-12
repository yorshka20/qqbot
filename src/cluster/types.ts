/**
 * Agent Cluster shared type definitions.
 */

// ── Event types ──

export interface EventEntry {
  seq: number;
  /** Epoch milliseconds — used for in-memory ring buffer ordering and cursor math. */
  timestamp: number;
  createdAt: string;
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
  /** Ticket id that dispatched this job. Used for result writeback. */
  ticketId?: string;
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
  /**
   * Phase 3 multi-agent: parent task that spawned this one via `hub_spawn`.
   * `undefined` → root task (user-submitted ticket / command).
   * Set → child task created by a planner worker. The cluster_tasks SQL
   * column is named `parentTaskId`.
   */
  parentTaskId?: string;
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

// ── Phase 3 multi-agent: planner spawn/query tools ──

export interface HubSpawnInput {
  /** The full prompt text the executor child worker will receive. */
  description: string;
  /** Required: planner must explicitly choose which executor template to use. */
  template: string;
  /**
   * Optional role tag. Only `'executor'` is permitted — planners are not
   * allowed to spawn nested planners (one-layer rule). Defaults to executor
   * if omitted; explicit `'planner'` is rejected by the hub.
   */
  role?: 'executor';
  /** Optional capability hints (informational; not yet used by scheduler). */
  capabilities?: string[];
}

export interface HubSpawnOutput {
  childTaskId: string;
  /** `'running'` if a worker was spawned immediately, `'queued'` if pool full. */
  status: 'queued' | 'running';
}

export interface HubQueryTaskInput {
  taskId: string;
}

export interface HubQueryTaskOutput {
  taskId: string;
  status: TaskStatus;
  workerId?: string;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface HubWaitTaskInput {
  taskId: string;
  /** Default 600_000 ms (10 min). Hub also enforces an absolute upper bound. */
  timeoutMs?: number;
}

// ── Worker Backend types ──

export interface WorkerSpawnConfig {
  workerId: string;
  taskPrompt: string;
  projectPath: string;
  /**
   * Path to a generated MCP server config (Claude CLI format).
   * Backends that don't consume this format (e.g. codex, gemini) ignore it
   * and arrange MCP wiring through their own config locations.
   */
  mcpConfigPath: string;
  /** Hub URL — used by backends that inject MCP config into provider-native locations. */
  hubUrl: string;
  /** Executable to invoke (template.command). */
  command: string;
  /** Base CLI args (template.args). The backend appends prompt-related args. */
  args: string[];
  /** Environment variables: process.env + template.env + cluster-injected vars. */
  env: Record<string, string>;
  timeout: number;
}

/**
 * Result of parsing a worker process's stdout into a final user-facing message.
 *
 * Backends that emit JSONL streaming output (claude `--output-format stream-json`,
 * codex `--json`, gemini `--output-format stream-json`) can implement
 * `parseOutput` to extract just the final assistant message and surface
 * raw events on `task.metadata` for debugging.
 */
export interface ParsedWorkerOutput {
  /** Final user-facing message — what to store in `task.output`. */
  finalMessage: string;
  /**
   * Optional structured representation of all events for debug/replay.
   * If present, WorkerPool serializes it into `task.metadata`.
   */
  rawEvents?: unknown;
}

export interface WorkerBackend {
  name: string;
  spawn(config: WorkerSpawnConfig): Promise<import('bun').Subprocess>;
  /**
   * Optional: parse the worker's stdout into a clean final message.
   * Default behavior (when not implemented) is to use the raw stdout
   * as `finalMessage` verbatim.
   */
  parseOutput?(raw: string): ParsedWorkerOutput;
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
