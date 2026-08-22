// Types for the Claude Code service and its HTTP callback API

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

export type ClaudeTaskType = 'dev' | 'new-project';

export interface ClaudeTask {
  id: string;
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
  taskType?: ClaudeTaskType;
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

// Tool execution types
export interface ToolExecuteParams {
  tool: string;
  parameters: Record<string, unknown>;
  taskId?: string;
}

export interface ToolExecuteResult {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  examples?: string[];
  whenToUse?: string;
}

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  description: string;
  enum?: string[];
  default?: unknown;
}

// Prompt template types
export interface PromptTemplateVariables {
  taskId: string;
  userPrompt: string;
  workingDirectory: string;
  mcpApiUrl: string;
  targetType: 'user' | 'group';
  targetId: string;
}

/**
 * Interface for tool executors managed by ToolRegistry
 */
export interface ToolExecutor {
  name: string;
  definition: ToolDefinition;
  execute(parameters: Record<string, unknown>): Promise<ToolExecuteResult>;
}

/**
 * Abstract base class for tool executors
 * Provides helper methods for creating success/error results
 */
export abstract class BaseToolExecutor implements ToolExecutor {
  abstract name: string;
  abstract definition: ToolDefinition;

  abstract execute(parameters: Record<string, unknown>): Promise<ToolExecuteResult>;

  protected success(message: string, data?: unknown): ToolExecuteResult {
    return { success: true, message, data };
  }

  protected error(error: string, message?: string): ToolExecuteResult {
    return { success: false, error, message };
  }
}
