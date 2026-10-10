// Types for the coding-agent service and its MCP callback API

export interface TaskNotification {
  taskId: string;
  status: 'started' | 'progress' | 'completed' | 'failed';
  message?: string;
  progress?: number; // 0-100
  result?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectContext {
  alias: string;
  type: 'bun' | 'node' | 'python' | 'rust' | 'generic';
  description?: string;
  hasClaudeMd: boolean;
  promptTemplateKey?: string;
}

/**
 * `dev` / `new-project` work inside a project tree. `workspace` does anything
 * asked from chat — research, building a page, a script, a document — in its
 * own throwaway directory outside any repository, and delivers to the chat.
 */
export type AgentTaskType = 'dev' | 'new-project' | 'workspace';

/** The CLIs a task can be executed by. The prompt and requirements are the same for all of them. */
export const AGENT_EXECUTOR_NAMES = ['claude', 'codex', 'dsh'] as const;
export type AgentExecutorName = (typeof AGENT_EXECUTOR_NAMES)[number];

/** Per-task overrides of the executor's model and reasoning effort, validated against its catalog. */
export interface AgentRunOptions {
  model?: string;
  effort?: string;
}

export interface AgentTask {
  id: string;
  executor: AgentExecutorName;
  model: string;
  /** Unset means the CLI's own default effort. */
  effort?: string;
  prompt: string;
  workingDirectory?: string;
  /**
   * Directory holding this task's record (`TASK.md`, `task.json`, `events.jsonl`, the raw
   * output). Equals `workingDirectory` for a workspace task; for a dev task the record sits
   * outside the repository it edits.
   */
  recordDirectory?: string;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  status: 'pending' | 'running' | 'completed' | 'failed';
  requestedBy: {
    type: 'user' | 'group';
    id: string;
    /** The person who asked; absent for tasks an agenda item started. */
    userId?: string;
    messageId?: string;
  };
  result?: string;
  error?: string;
  /** Task type */
  taskType?: AgentTaskType;
  /** Project context resolved from ProjectRegistry */
  projectContext?: ProjectContext;
  /** When true, the global handleTaskUpdate callback skips sending result messages */
  suppressDefaultNotification?: boolean;
}

export interface BotInfo {
  selfId: string | null;
  connectedProtocols: string[];
  uptime: number;
  taskQueue: {
    pending: number;
    running: number;
  };
}

// Command execution types
export type BotCommandName = 'restart' | 'reload-plugins' | 'status';

export interface ExecuteCommandParams {
  command: BotCommandName;
  args?: string[];
}

export interface ExecuteCommandResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: Record<string, unknown>;
}
