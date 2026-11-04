// Configuration slices owned by the agent-cluster package; the bot's `BotConfig` composes them.

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
    // Worktree slots for this project's executors (default: its effective executor
    // concurrency). 0 keeps every worker in `path`; they then share one checkout and one
    // git index, so keep that project's concurrency at 1.
    worktrees?: number;
    // Branch a job's integration branch is cut from (default: the repo's default branch)
    baseBranch?: string;
    // Run in a slot when the lockfile changed (default: `bun install` / `npm install` by type)
    install?: string;
    // Shell command run after each merge, on the integration branch's content
    publish?: string;
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

/**
 * Tickets storage configuration.
 *
 * Tickets are cross-repo work units: each ticket has a `project` frontmatter
 * field that points at a registered project alias, and the cluster resolves
 * that alias to the real repo path at dispatch time. Storing tickets inside
 * the qqbot repo forces every project's work items to be committed into
 * qqbot's git history, which is awkward when the ticket targets a different
 * codebase. This config lets the tickets directory live anywhere on disk —
 * typically a dedicated `cluster-tickets` repo shared across bot instances.
 *
 * Callsites that consume this directory:
 *   - `TicketBackend`                (read/write ticket markdown + results)
 *   - `ContextHub.handleWritePlan`   (write `<ticketsDir>/<id>/plan.md`)
 *   - `ContextHub.handleReadPlan`    (read that same plan)
 *   - `ClusterTicketWriteback`       (write job results into `<ticketsDir>/<id>/results/`)
 *
 * The ticket body template (`.templates/ticket.md` under the tickets dir)
 * also lives here so new ticket skeletons are version-controlled alongside
 * the tickets themselves.
 */
export interface TicketsConfig {
  /**
   * Filesystem directory where ticket markdown lives. Absolute path
   * recommended. Relative paths resolve against the repo root (resolved via
   * `getRepoRoot()`, independent of launch cwd). Defaults to
   * `tickets` (i.e. `<repoRoot>/tickets`) when the whole `tickets` block is
   * absent, preserving the pre-externalization behavior.
   */
  dir: string;
}

/**
 * The `clusterDaemon` block of the shared config tree (`config.d/`): what only the daemon
 * process needs. Everything else the daemon reads (`cluster`, `codingAgent.projectRegistry`,
 * `tickets`) is the same block the bot reads, so there is one configuration, not two.
 */
export interface ClusterDaemonSettings {
  // Where the daemon keeps state: SQLite, lock, worker logs, MCP configs, the console build.
  // Relative paths resolve against the repo root (default: `data/cluster`).
  stateDir?: string;
  // The one port for `/mcp`, `/api/cluster`, `/api/tickets`, `/health` and the console
  // (default: 0.0.0.0:3200; "127.0.0.1" keeps the console off the LAN).
  http?: { host?: string; port?: number };
  // Bearer token `/api/*` and `/health` require. The bot's `clusterClient` defaults to it.
  auth: { token: string };
}
