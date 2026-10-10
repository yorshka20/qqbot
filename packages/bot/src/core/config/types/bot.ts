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
  // CLI binary (default: the executor name, 'claude' / 'codex' / 'dsh')
  cliPath?: string;
  // Model passed to the CLI (default: 'claude-opus-5' for claude, 'gpt-6-sol' for codex,
  // 'deepseek-flash' for dsh)
  model?: string;
  // Reasoning effort when a task does not set one (default: the CLI's own default)
  effort?: string;
  // Extra models `--model` may select. Read for claude and dsh, whose CLIs expose no
  // model catalog to query; codex models come from `codex debug models`.
  models?: string[];
}

// DSH reaches its models through a named provider route, so it carries one field the
// other executors do not: which route authenticates the run.
export interface DshExecutorConfig extends AgentExecutorConfig {
  // Provider route (default: 'deepseek-account'). 'deepseek-account' spends the credits
  // of the DeepSeek Harness Desktop login already stored under $DSH_HOME and needs no
  // secret in the bot's environment; 'deepseek-official' bills an API key and therefore
  // needs DEEPSEEK_API_KEY exported to the bot.
  provider?: string;
}

export interface CodingAgentConfig {
  enabled: boolean;
  port: number;
  host?: string;
  // Executor used when a task does not name one (default: 'claude')
  defaultExecutor?: 'claude' | 'codex' | 'dsh';
  executors?: {
    claude?: AgentExecutorConfig;
    codex?: AgentExecutorConfig;
    dsh?: DshExecutorConfig;
  };
  // Working directory for tasks that do not resolve to a registered project
  workingDirectory?: string;
  // Parent of the per-task directories workspace tasks run in (default: <os tmpdir>/qqbot-agent-workspaces).
  // Must be outside any repository: both CLIs load CLAUDE.md / AGENTS.md from parent directories.
  workspaceRoot?: string;
  // Largest file a workspace task may send to chat with bot_send_file, in MB (default: 30)
  maxFileMB?: number;
  // Kill a task whose CLI shows no activity (output or MCP call) for this long (default: '15m')
  idleTimeout?: string;
  // Kill a task that runs longer than this in total (default: '3h')
  timeout?: string;
  // Max concurrent tasks (default: 1)
  maxConcurrentTasks?: number;
  // Project registry for multi-project support
  projectRegistry?: ProjectRegistryConfig;
}
