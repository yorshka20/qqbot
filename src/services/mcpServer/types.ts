// MCP Server types for Claude Code integration

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
}

export interface MCPServerConfig {
  enabled: boolean;
  port: number;
  host?: string;
  // Claude Code CLI path (default: 'claude')
  claudeCliPath?: string;
  // Working directory for Claude Code tasks
  workingDirectory?: string;
  // Allowed user IDs that can trigger Claude Code tasks
  allowedUsers?: string[];
  // Max concurrent tasks
  maxConcurrentTasks?: number;
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

// Prompt template types
export interface PromptTemplateVariables {
  taskId: string;
  userPrompt: string;
  workingDirectory: string;
  mcpApiUrl: string;
  targetType: 'user' | 'group';
  targetId: string;
  guidelines?: string;
}
