/**
 * Agent Cluster configuration schema and parsing.
 */

export interface ClusterConfig {
  enabled: boolean;
  schedulingInterval: number; // ms
  maxConcurrentWorkers: number;

  hub: {
    port: number;
    host: string;
    lockTTL: number; // ms
    eventLogMaxSize: number;
  };

  workerTemplates: Record<string, WorkerTemplateConfig>;

  /**
   * Phase 3 multi-agent: name of the worker template the scheduler should
   * pick when a ticket is dispatched with `usePlanner: true` but doesn't
   * specify its own template. Must reference a `workerTemplates` entry
   * whose `role === 'planner'`. Optional — if unset, planner dispatches
   * with no explicit template fall back to the first planner-role
   * template found in `workerTemplates`.
   */
  defaultPlannerTemplate?: string;

  projects: Record<string, ClusterProjectConfig>;

  notifications: {
    qq?: {
      events: string[];
      digestTime?: string;
      target?: {
        type: 'user' | 'group';
        id: string;
      };
    };
    webui?: {
      events: string[];
    };
  };

  quietHours?: {
    enabled: boolean;
    start: string;
    end: string;
    timezone: string;
  };
}

export type WorkerBackendType = 'claude-cli' | 'codex-cli' | 'gemini-cli' | 'minimax-cli';

export type WorkerTemplateRole = 'planner' | 'executor';

export interface WorkerTemplateConfig {
  type: WorkerBackendType;
  /**
   * Phase 3 multi-agent role tag. Defaults to `'executor'` (backwards
   * compatible — pre-Phase-3 templates are all executors). A `'planner'`
   * template gets a different system prompt and is the only template
   * type the scheduler will pick when a ticket is dispatched with
   * `usePlanner: true`.
   *
   * Only one layer of planning is supported: planner-spawned children
   * always run on executor templates (the hub_spawn tool rejects
   * `role: 'planner'`). See docs/local/agent-cluster-phase3-multi-agent.md
   * for the full design.
   */
  role?: WorkerTemplateRole;
  command: string;
  args: string[];
  /**
   * Environment variables injected into the worker process.
   * Useful for API keys, base URL overrides, model selection, etc.
   * For "minimax-cli" templates, only `ANTHROPIC_API_KEY` is required —
   * the backend bakes in MiniMax CN's base URL and default model.
   */
  env?: Record<string, string>;
  maxConcurrent: number;
  timeout: number; // ms
  capabilities: string[];
  costTier: 'low' | 'medium' | 'high';
}

export interface ClusterProjectConfig {
  maxWorkers: number;
  taskSources: Array<{
    type: 'todo-file' | 'queue';
    path?: string;
    pollInterval?: number; // ms
  }>;
  workerPreference: string;
  plannerTemplate?: string;
}

function defaultCommandForType(type: WorkerBackendType): string {
  switch (type) {
    case 'codex-cli':
      return 'codex';
    case 'gemini-cli':
      return 'gemini';
    case 'minimax-cli':
      // minimax-cli is a façade that delegates to the `claude` binary
      // (see MinimaxBackend) with MiniMax CN env vars baked in.
      return 'claude';
    default:
      return 'claude';
  }
}

function defaultArgsForType(type: WorkerBackendType): string[] {
  switch (type) {
    case 'codex-cli':
      return ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'];
    case 'gemini-cli':
      return ['--approval-mode=yolo', '--output-format', 'stream-json'];
    case 'minimax-cli':
      // Same flags as claude-cli — minimax just routes to a different host.
      return ['--print', '--dangerously-skip-permissions', '--output-format', 'text'];
    default:
      return ['--print', '--dangerously-skip-permissions', '--output-format', 'text'];
  }
}

/**
 * Parse duration string to milliseconds.
 * Supports: "30s", "5m", "1h", "600s"
 */
export function parseDuration(raw: string): number {
  const match = raw.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) return parseInt(raw, 10) || 30000;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60_000;
    case 'h':
      return value * 3_600_000;
    default:
      return value;
  }
}

/**
 * Build a ClusterConfig from raw config object (e.g. from config.jsonc).
 * Applies defaults for missing fields.
 */
export function parseClusterConfig(raw: Record<string, unknown> | undefined): ClusterConfig | null {
  if (!raw || !(raw as Record<string, unknown>).enabled) return null;

  const r = raw as Record<string, unknown>;
  const hubRaw = (r.hub as Record<string, unknown>) || {};
  const templatesRaw = (r.workerTemplates as Record<string, Record<string, unknown>>) || {};
  const projectsRaw = (r.projects as Record<string, Record<string, unknown>>) || {};
  const notificationsRaw = (r.notifications as Record<string, unknown>) || {};

  const workerTemplates: Record<string, WorkerTemplateConfig> = {};
  for (const [name, tpl] of Object.entries(templatesRaw)) {
    const rawType = (tpl.type as string) || 'claude-cli';
    const type: WorkerBackendType =
      rawType === 'codex-cli' || rawType === 'gemini-cli' || rawType === 'minimax-cli' ? rawType : 'claude-cli';
    const rawRole = tpl.role as string | undefined;
    const role: WorkerTemplateRole | undefined = rawRole === 'planner' || rawRole === 'executor' ? rawRole : undefined;
    workerTemplates[name] = {
      type,
      role,
      command: (tpl.command as string) || defaultCommandForType(type),
      args: (tpl.args as string[]) || defaultArgsForType(type),
      env: (tpl.env as Record<string, string>) || undefined,
      maxConcurrent: (tpl.maxConcurrent as number) || 4,
      timeout: typeof tpl.timeout === 'string' ? parseDuration(tpl.timeout) : (tpl.timeout as number) || 600_000,
      capabilities: (tpl.capabilities as string[]) || [],
      costTier: (tpl.costTier as 'low' | 'medium' | 'high') || 'medium',
    };
  }

  const projects: Record<string, ClusterProjectConfig> = {};
  for (const [name, proj] of Object.entries(projectsRaw)) {
    const sources = ((proj.taskSources as Array<Record<string, unknown>>) || []).map((s) => ({
      type: (s.type as 'todo-file' | 'queue') || 'queue',
      path: s.path as string | undefined,
      pollInterval:
        typeof s.pollInterval === 'string' ? parseDuration(s.pollInterval) : (s.pollInterval as number | undefined),
    }));
    projects[name] = {
      maxWorkers: (proj.maxWorkers as number) || 3,
      taskSources: sources,
      workerPreference: (proj.workerPreference as string) || Object.keys(workerTemplates)[0] || 'claude-sonnet',
      plannerTemplate: proj.plannerTemplate as string | undefined,
    };
  }

  return {
    enabled: true,
    schedulingInterval:
      typeof r.schedulingInterval === 'string'
        ? parseDuration(r.schedulingInterval)
        : (r.schedulingInterval as number) || 30_000,
    maxConcurrentWorkers: (r.maxConcurrentWorkers as number) || 6,
    hub: {
      port: (hubRaw.port as number) || 3200,
      host: (hubRaw.host as string) || '127.0.0.1',
      lockTTL:
        typeof hubRaw.lockTTL === 'string' ? parseDuration(hubRaw.lockTTL) : (hubRaw.lockTTL as number) || 600_000,
      eventLogMaxSize: (hubRaw.eventLogMaxSize as number) || 1000,
    },
    workerTemplates,
    defaultPlannerTemplate: typeof r.defaultPlannerTemplate === 'string' ? r.defaultPlannerTemplate : undefined,
    projects,
    notifications: {
      qq: notificationsRaw.qq as ClusterConfig['notifications']['qq'],
      webui: notificationsRaw.webui as ClusterConfig['notifications']['webui'],
    },
    quietHours: r.quietHours as ClusterConfig['quietHours'],
  };
}
