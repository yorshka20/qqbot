// Bot self configuration

export interface BotSelfConfig {
  selfId: string;
  // Bot owner: highest permission level, can use all commands
  owner: string;
  // Bot admins: user IDs that have admin permission level
  // These users can adjust bot behavior and trigger special commands
  admins: string[];
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
  // Allowed user IDs that can trigger Claude Code tasks (empty = all allowed)
  allowedUsers?: string[];
  // Max concurrent tasks (default: 1)
  maxConcurrentTasks?: number;
  // Project registry for multi-project support
  projectRegistry?: ProjectRegistryConfig;
}
