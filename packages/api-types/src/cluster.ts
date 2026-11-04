// `/api/cluster` — agent cluster control plane.

import type { PaginatedResponse } from './common';

export type ClusterJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ClusterTaskStatus = 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';
export type ClusterTaskSource = 'todo-file' | 'queue' | 'planner';
export type ClusterWorkerRole = 'coder' | 'planner' | 'reviewer' | 'custom';
/** Registry state of a worker; `/status` reports a different, finer vocabulary. */
export type ClusterWorkerRegistryStatus = 'active' | 'idle' | 'exited';
export type ClusterWorkerRuntimeStatus = 'starting' | 'running' | 'idle' | 'stopping' | 'exited';
export type ClusterReportStatus = 'working' | 'completed' | 'failed' | 'blocked';
export type ClusterHelpRequestType = 'clarification' | 'decision' | 'conflict' | 'escalation';
export type ClusterHelpRequestStatus = 'pending' | 'answered' | 'expired';

export type ClusterEventType =
  | 'file_changed'
  | 'task_completed'
  | 'task_failed'
  | 'task_blocked'
  | 'task_merged'
  | 'task_published'
  | 'task_publish_failed'
  | 'task_subscribed'
  | 'worker_progress'
  | 'directive'
  | 'answer'
  | 'lock_released'
  | 'lock_acquired'
  | 'worker_joined'
  | 'worker_left'
  | 'message'
  | 'help_request';

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
    status: ClusterWorkerRuntimeStatus;
    currentTaskDescription?: string;
    uptime: number;
  }>;
  worktrees: ClusterWorktreePool[];
}

/** One project's worktree pool. Only slots in use are listed; `size` is what the pool may grow to. */
export interface ClusterWorktreePool {
  project: string;
  /** Executor slots. */
  size: number;
  /** Planner slots, separate so a waiting planner never holds a slot its children need. */
  plannerSize: number;
  leased: ClusterWorktreeLease[];
}

export interface ClusterWorktreeLease {
  slot: string;
  kind: 'executor' | 'planner';
  path: string;
  taskId: string;
  leasedAt: string;
}

/** `GET /api/cluster/status` — answers whether or not the cluster is started. */
export interface ClusterStatusResponse {
  started: boolean;
  status: ClusterStatus;
}

/**
 * A worker as the hub registry holds it. The job / ticket fields are filled in only
 * by the routes that resolve them (`/workers`, `/jobs/:id/workers`) — the SSE `init`
 * event carries the bare registry row, which is why they are optional here.
 */
export interface ClusterWorkerRegistration {
  workerId: string;
  role: ClusterWorkerRole;
  project: string;
  templateName: string;
  status: ClusterWorkerRegistryStatus;
  currentTaskId?: string;
  /** Kept after a terminal report clears `currentTaskId`, so the task stays attributable. */
  lastBoundTaskId?: string;
  /** Epoch ms when the worker process ended. */
  exitedAt?: number;
  lastSeen: number;
  syncCursor: number;
  /** Epoch ms of the last report of any status. */
  lastHubReportAt?: number;
  lastReportSummary?: string;
  lastReportNextSteps?: string;
  lastReportStatus?: ClusterReportStatus;
  stats: {
    tasksCompleted: number;
    tasksFailed: number;
    totalReports: number;
    registeredAt: number;
  };
  /** Mirrors `stats.registeredAt`. */
  spawnedAt?: number;
  boundJobId?: string;
  boundTicketId?: string;
  boundTaskSummary?: string;
  /** Task id the server resolved the worker to, falling back to the database. */
  resolvedTaskId?: string;
}

/** A registration from a route that resolves the worker's job, so `spawnedAt` is present. */
export interface EnrichedWorkerRegistration extends ClusterWorkerRegistration {
  spawnedAt: number;
}

/** A registration from the database history query, which knows its job. */
export interface ClusterWorkerHistoryEntry extends ClusterWorkerRegistration {
  jobId?: string;
}

export interface ClusterJob {
  id: string;
  project: string;
  description: string;
  status: ClusterJobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  taskCount: number;
  tasksCompleted: number;
  tasksFailed: number;
  metadata?: string;
  /** The ticket that dispatched this job, when it came from one. */
  ticketId?: string;
  /** Branch the job's finished tasks merge into, where the owner accepts the work. */
  integrationBranch?: string;
}

export interface ClusterTask {
  id: string;
  jobId: string;
  project: string;
  description: string;
  status: ClusterTaskStatus;
  workerId?: string;
  workerTemplate?: string;
  source: ClusterTaskSource;
  createdAt: string;
  claimedAt?: string;
  startedAt?: string;
  completedAt?: string;
  /** Live stdout; in-memory only, so a task read back from the database has none. */
  output?: string;
  error?: string;
  filesModified?: string;
  diffSummary?: string;
  metadata?: string;
  /** Unset on a root task; set to the planner's task id on a task a planner spawned. */
  parentTaskId?: string;
  /** OS pid of the worker process, while it runs. */
  workerPid?: number;
  workerStartedAt?: string;
  /** The worker's stdout log file on the cluster host. */
  logPath?: string;
  /** The backend's own session id (claude / codex / dsh), once known. */
  sessionId?: string;
  /** When a person marked the task as seen; unset while the inbox still lists it. */
  acknowledgedAt?: string;
  /** The model the worker runs on: what its CLI reported, else the template's `--model`. */
  model?: string;
  /** Token usage the worker's CLI reported; cumulative while running, the CLI's totals once ended. */
  usage?: ClusterTaskUsage;
  /** The task's own branch; unset on a task that ran in the project checkout. */
  branch?: string;
  /** The worktree slot the worker ran in. */
  worktreePath?: string;
  /** When the task's branch landed on the job's integration branch. */
  mergedAt?: string;
  /** Length of the whole stdout buffer; set only by the job-detail route. */
  outputBytes?: number;
  /** True when `output` is a tail slice rather than the whole buffer. */
  outputTruncated?: boolean;
}

export interface ClusterTaskUsage {
  /** Tokens in the context the model last saw (input + cache read + cache creation of the latest request). */
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns?: number;
  costUsd?: number;
  /** True once the CLI reported its final totals. */
  final?: boolean;
}

/** What a task's worker subscribed to. Live only: rows go when the worker exits, `task_subscribed` events stay on the task's timeline. */
export interface ClusterTaskSubscriptions {
  /** Sibling task ids. */
  tasks: string[];
  /** Repo-relative paths or globs. */
  files: string[];
  /** Anything landing on the job's integration branch. */
  branch: boolean;
  /** The subset of `tasks` that must land before this task starts: the plan's `depends_on`. */
  dependsOn: string[];
}

/** SSE `task_subscribed`, and `data` of the event of that name: the task's whole subscription set after the change. */
export interface ClusterTaskSubscribedEvent {
  taskId: string;
  jobId: string;
  subscriptions: ClusterTaskSubscriptions;
}

/** `GET /api/cluster/tasks/:id` — a planner task also carries the tasks it spawned. */
export interface ClusterTaskDetail extends ClusterTask {
  children?: ClusterTask[];
  /** Unset when the task has no live subscriptions. */
  subscriptions?: ClusterTaskSubscriptions;
}

export interface ClusterEventEntry {
  seq: number;
  /** Epoch ms. */
  timestamp: number;
  createdAt: string;
  type: ClusterEventType;
  sourceWorkerId: string;
  targetWorkerId?: string;
  data: Record<string, unknown>;
  jobId?: string;
  taskId?: string;
}

/** Shape of `ClusterEventEntry.data` on a `worker_progress` / `task_*` event. */
export interface ReportEventDetail {
  error?: string;
  blockReason?: string;
  linesAdded?: number;
  linesRemoved?: number;
  testsRan?: number;
  testsPassed?: number;
}

export interface ReportEventData {
  status?: ClusterReportStatus;
  summary?: string;
  nextSteps?: string;
  filesModified?: string[];
  detail?: ReportEventDetail;
}

/** `GET /api/cluster/events` and `/tasks/:id/events` — a bare array, not a page. */
export type ClusterEventListResponse = ClusterEventEntry[];

/** `GET /api/cluster/jobs/:id` */
export interface ClusterJobWithTasks extends ClusterJob {
  tasks: ClusterTask[];
}

export interface ClusterJobWithDetail extends ClusterJobWithTasks {
  workers?: EnrichedWorkerRegistration[];
}

export interface ClusterWorkerTemplate {
  name: string;
  type: string;
  /** A root planner task may only run on a planner-role template. */
  role?: 'planner' | 'executor';
  command: string;
  /** The model the template pins (`--model` argument or the backend's model env var), when it does. */
  model?: string;
  maxConcurrent: number;
  capabilities: string[];
  costTier: 'low' | 'medium' | 'high';
}

/** `GET /api/cluster/templates`; `projectDefaults` maps a project alias to its preferred template. */
export interface ClusterTemplatesResponse {
  templates: ClusterWorkerTemplate[];
  projectDefaults: Record<string, string>;
}

export interface ClusterLock {
  filePath: string;
  workerId: string;
  taskId?: string;
  claimedAt: number;
  lastRenewed: number;
  ttl: number;
}

export interface ClusterHelpRequest {
  id: string;
  workerId: string;
  taskId?: string;
  type: ClusterHelpRequestType;
  question: string;
  context?: string;
  options?: string[];
  status: ClusterHelpRequestStatus;
  answer?: string;
  answeredBy?: string;
  createdAt: string;
  answeredAt?: string;
}

/** `POST /api/cluster/jobs` */
export interface ClusterJobSubmitBody {
  project: string;
  description: string;
  workerTemplate?: string;
  /** Require the resolved template to have `role: 'planner'`. */
  requirePlannerRole?: boolean;
  /** Ticket to write the job's result back to. */
  ticketId?: string;
}

/** `POST /api/cluster/{tasks,jobs}/:id/kill` */
export interface ClusterCancelBody {
  reason?: string;
}

/** `POST /api/cluster/tasks/:id/messages` — a person's message to the task's running worker. */
export interface ClusterTaskMessageBody {
  text: string;
  /** Who writes; shown on the timeline. Defaults to `owner`. */
  from?: string;
}

/** `POST /api/cluster/tasks/:id/messages` */
export interface ClusterTaskMessagedResponse {
  delivered: boolean;
  workerId: string;
}

/** `POST /api/cluster/tasks/:id/acknowledge` */
export interface ClusterTaskAcknowledgedResponse {
  taskId: string;
  acknowledgedAt: string;
}

/** `POST /api/cluster/help/:id/answer` */
export interface ClusterHelpAnswerBody {
  answer: string;
  answeredBy?: string;
}

/** `POST /api/cluster/start` and `/stop` */
export interface ClusterStartedResponse {
  started: boolean;
}

/** `POST /api/cluster/pause` and `/resume` */
export interface ClusterPausedResponse {
  paused: boolean;
}

/** `POST /api/cluster/workers/:id/kill` */
export interface ClusterWorkerKilledResponse {
  killed: boolean;
}

/** `POST /api/cluster/tasks/:id/kill` */
export interface ClusterTaskCancelledResponse {
  cancelled: boolean;
  taskId: string;
  cascadedChildren: number;
}

/** `POST /api/cluster/jobs/:id/kill` */
export interface ClusterJobCancelledResponse {
  cancelled: boolean;
  jobId: string;
  cancelledTasks: number;
}

/** `POST /api/cluster/help/:id/answer` */
export interface ClusterHelpAnsweredResponse {
  answered: boolean;
}

/** `GET /api/cluster/history/jobs` */
export type ClusterJobHistoryResponse = PaginatedResponse<ClusterJob>;

/** `GET /api/cluster/history/workers` */
export type ClusterWorkerHistoryResponse = PaginatedResponse<ClusterWorkerHistoryEntry>;

/** `GET /health` on the cluster daemon — what the supervisor and the bot client read to tell it is up. */
export interface ClusterDaemonHealthResponse {
  ok: boolean;
  startedAt: string;
  cluster: {
    running: boolean;
    paused: boolean;
    activeWorkers: number;
  };
}
