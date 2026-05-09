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

export interface ClaudeCodeServiceConfig {
  enabled: boolean;
  port: number;
  host?: string;
  // Claude Code CLI path (default: 'claude')
  claudeCliPath?: string;
  // Working directory for Claude Code tasks
  workingDirectory?: string;
  // Max concurrent tasks (default: 1)
  maxConcurrentTasks?: number;
  // Project registry for multi-project support
  projectRegistry?: ProjectRegistryConfig;
}
