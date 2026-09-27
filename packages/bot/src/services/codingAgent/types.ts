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

export interface SendMessageParams {
  target: {
    type: 'user' | 'group';
    id: string;
  };
  content: string;
  replyTo?: string; // Message ID to reply to
}

export interface ProjectContext {
  alias: string;
  type: 'bun' | 'node' | 'python' | 'rust' | 'generic';
  description?: string;
  hasClaudeMd: boolean;
  promptTemplateKey?: string;
}

export type AgentTaskType = 'dev' | 'new-project';

/** The CLIs a task can be executed by. The prompt and requirements are the same for all of them. */
export const AGENT_EXECUTOR_NAMES = ['claude', 'codex'] as const;
export type AgentExecutorName = (typeof AGENT_EXECUTOR_NAMES)[number];

export interface AgentTask {
  id: string;
  executor: AgentExecutorName;
  prompt: string;
  workingDirectory?: string;
  createdAt: Date;
  status: 'pending' | 'running' | 'completed' | 'failed';
  requestedBy: {
    type: 'user' | 'group';
    id: string;
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
