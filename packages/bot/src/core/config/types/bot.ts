// Bot self configuration

export interface BotSelfConfig {
  selfId: string;
  // Bot owner: highest permission level, can use all commands
  owner: string;
  // Bot admins: user IDs that have admin permission level
  // These users can adjust bot behavior and trigger special commands
  admins: string[];
  // Bot's own nickname/display name as users see it in chat. Injected into the
  // base system prompt so the LLM can recognize when a user is addressing it
  // by name rather than only by @QQ. Optional — leave empty to skip.
  nickname?: string;
}

export interface StaticServerConfig {
  port: number;
  host: string;
  root: string;
}

export interface FileReadServiceConfig {
  root: string;
  filterPaths: string[];
  filterExtensions: string[];
}

export interface ProjectRegistryConfig {
  // Security whitelist: only allow projects under these directories
  allowedBasePaths: string[];
  // Default project alias (used when no @alias specified)
  defaultProject: string;
  // Pre-registered projects
  projects: Array<{
    alias: string;
    path: string;
    type?: 'bun' | 'node' | 'python' | 'rust' | 'generic';
    description?: string;
    promptTemplateKey?: string;
  }>;
}

export interface AgentExecutorConfig {
  // CLI binary (default: the executor name, 'claude' / 'codex')
  cliPath?: string;
  // Model passed to the CLI (default: 'claude-opus-5' for claude, 'gpt-6-sol' for codex)
  model?: string;
  // Reasoning effort when a task does not set one (default: the CLI's own default)
  effort?: string;
  // Extra models `--model` may select. Only read for claude, whose CLI has no model
  // catalog; codex models come from `codex debug models`.
  models?: string[];
}

export interface CodingAgentConfig {
  enabled: boolean;
  port: number;
  host?: string;
  // Executor used when a task does not name one (default: 'claude')
  defaultExecutor?: 'claude' | 'codex';
  executors?: {
    claude?: AgentExecutorConfig;
    codex?: AgentExecutorConfig;
  };
  // Working directory for tasks that do not resolve to a registered project
  workingDirectory?: string;
  // Kill a task whose CLI shows no activity (output or MCP call) for this long (default: '15m')
  idleTimeout?: string;
  // Kill a task that runs longer than this in total (default: '3h')
  timeout?: string;
  // Max concurrent tasks (default: 1)
  maxConcurrentTasks?: number;
  // Project registry for multi-project support
  projectRegistry?: ProjectRegistryConfig;
}
