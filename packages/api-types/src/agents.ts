// `/api/agents` — coding-agent task records. Read-only except for cancel; the records
// outlive the process, so the task routes answer even when the service is off.

export type AgentTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/** One task's stored state, as the task store writes it to `task.json`. */
export interface AgentTaskRecord {
  id: string;
  executor: string;
  model: string;
  effort?: string;
  taskType: string;
  projectAlias?: string;
  workingDirectory: string;
  prompt: string;
  requestedBy: {
    type: 'user' | 'group';
    id: string;
    /** The person who asked; absent for a task an agenda item started. */
    userId?: string;
    messageId?: string;
  };
  status: AgentTaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: string;
  error?: string;
  /** The record directory on disk — also the working directory of a workspace task. */
  directory: string;
}

/** One line of a task's timeline. */
export interface AgentTaskEvent {
  kind: 'created' | 'running' | 'progress' | 'completed' | 'failed';
  at: number;
  message?: string;
  progress?: number;
}

/** `GET /api/agents/tasks/:id/output` — tail-capped by the backend. */
export interface AgentTaskOutput {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface AgentExecutorInfo {
  name: string;
  displayName: string;
}

export interface AgentQueueEntry {
  project: string;
  running: string | null;
  queued: number;
}

/** `GET /api/agents/status`; everything but `enabled` is absent when the service is off. */
export interface AgentsStatusResponse {
  enabled: boolean;
  defaultExecutor?: string;
  executors: AgentExecutorInfo[];
  runningTasks?: number;
  pendingTasks?: number;
  queue?: AgentQueueEntry[];
}

/** `GET /api/agents/tasks` — newest first, with the prompt and result shortened. */
export interface AgentTasksResponse {
  enabled: boolean;
  tasks: AgentTaskRecord[];
}

/** `POST /api/agents/tasks/:id/cancel` — false when the task is not running here. */
export interface AgentTaskCancelledResponse {
  cancelled: boolean;
}
