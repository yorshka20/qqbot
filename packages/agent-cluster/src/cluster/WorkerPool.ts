/**
 * WorkerPool — manages worker instance lifecycles.
 *
 * Workers are detached processes: they run in their own process group with stdout and
 * stderr written to files under `<stateDir>/assignments/`, and the pool follows those
 * files instead of holding pipes. A scheduler restart therefore leaves every worker
 * running; on start the scheduler hands the pool the tasks that were running (`adopt`)
 * and the pool picks them up again by pid. Stopping the pool stops following them; it
 * kills them only when asked to.
 */

import { type ChildProcess, spawn as spawnChild, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { getRepoRoot, logger, randomUUID } from '@qqbot/shared';
import type { ClusterConfig, WorkerBackendType } from './config';
import type { ContextHub } from './hub/ContextHub';
import { LogTail } from './LogTail';
import {
  loadClusterPrompt,
  planningPromptName,
  renderPrompt,
  workspacePromptName,
  workspacePromptVars,
} from './prompts';
import {
  type ClusterStatus,
  isTerminalTaskStatus,
  type TaskRecord,
  type TaskUsage,
  type UsageSample,
  type WorkerBackend,
  type WorkerInstance,
  type WorkerLaunch,
  type WorkerWorkspace,
} from './types';

/**
 * Callback invoked when a worker process exits and its task transitions to
 * a terminal state (`completed` / `failed`). Receives the populated
 * `TaskRecord` with `output` / `error` / `completedAt` filled in.
 *
 * Wired by ClusterManager to `ClusterScheduler.markTaskCompleted` so the
 * scheduler can persist final state, update parent job counts, and remove
 * the task from `activeTasks`.
 */
export type TaskCompletedCallback = (task: TaskRecord) => void | Promise<void>;

/** Throttled notification of new stdout while a worker runs. */
export type TaskProgressCallback = (task: TaskRecord) => void | Promise<void>;

/** A durable field of a running task changed (pid, log path, session id) and should be persisted. */
export type TaskUpdatedCallback = (task: TaskRecord) => void;

/**
 * Maximum number of recently-exited workers retained in memory for
 * status / history queries before they fall off the FIFO buffer.
 */
const RECENTLY_EXITED_MAX = 50;

/** How often an adopted worker (no child handle) is checked for liveness. */
const LIVENESS_POLL_MS = 2000;

/** Slack allowed between a task's recorded start and the process start `ps` reports. */
const START_TIME_TOLERANCE_MS = 60_000;

/**
 * Relative paths (from project cwd) to the role-specific system
 * prompt files. Loaded once on first spawn of each role and cached. The
 * prompt is prepended to the worker's `taskPrompt` so every backend gets
 * role-mode behavior without per-backend changes — the LLM sees the
 * role instructions as the first thing in its task input.
 *
 * **Why files instead of inline strings**: prompts are content, not code.
 * They get edited and tuned independently of release cycles, sometimes
 * by non-engineers. Hardcoding them in TS would force a typecheck/build
 * round-trip on every prompt tweak and bury the content under quoting
 * noise. Files also let `git diff` show the actual prose change.
 */
const ROLE_SYSTEM_PROMPT_PATHS: Record<'planner' | 'coder', string> = {
  planner: 'prompts/cluster/planner-system.md',
  coder: 'prompts/cluster/executor-system.md',
};

/**
 * Placeholder in planner-system.md replaced at spawn time with a
 * config-derived table of spawnable executor templates. Keeps the
 * planner's worker catalog from drifting away from actual config — see
 * renderExecutorCatalog.
 */
const EXECUTOR_CATALOG_TOKEN = '{{CLUSTER_AVAILABLE_EXECUTORS}}';

const COST_TIER_ORDER: Record<'low' | 'medium' | 'high', number> = { low: 0, medium: 1, high: 2 };

/** What the pool keeps about a worker beyond the `WorkerInstance` the rest of the cluster sees. */
interface Followed {
  tail: LogTail;
  errPath: string;
  liveness: ReturnType<typeof setInterval> | null;
  cleanup?: () => Promise<void>;
  finalized: boolean;
}

/** How often a running task's usage is written to the database. */
const USAGE_PERSIST_MS = 10_000;

/**
 * Fold one usage sample into a task's running totals. A per-request sample adds to the sums
 * and sets the context size; the final sample replaces the sums with the CLI's own totals.
 */
export function applyUsage(current: TaskUsage | undefined, sample: UsageSample): TaskUsage {
  const context = sample.input + sample.cacheRead + sample.cacheCreation;
  if (sample.final) {
    return {
      contextTokens: current?.contextTokens ?? context,
      inputTokens: sample.input,
      outputTokens: sample.output,
      cacheReadTokens: sample.cacheRead,
      cacheCreationTokens: sample.cacheCreation,
      ...(sample.turns !== undefined ? { turns: sample.turns } : {}),
      ...(sample.costUsd !== undefined ? { costUsd: sample.costUsd } : {}),
      final: true,
    };
  }
  if (current?.final) return current;
  return {
    contextTokens: context,
    inputTokens: (current?.inputTokens ?? 0) + sample.input,
    outputTokens: (current?.outputTokens ?? 0) + sample.output,
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + sample.cacheRead,
    cacheCreationTokens: (current?.cacheCreationTokens ?? 0) + sample.cacheCreation,
    turns: (current?.turns ?? 0) + 1,
  };
}

/** The model a template pins: its `--model` argument, else the model env var its backend reads. */
export function templateModel(template: { args: string[]; env?: Record<string, string> }): string | undefined {
  const args = template.args;
  const idx = args.indexOf('--model');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  const inline = args.find((a) => a.startsWith('--model='))?.slice('--model='.length);
  if (inline) return inline;
  const m = args.indexOf('-m');
  if (m !== -1 && args[m + 1]) return args[m + 1];
  return template.env?.ANTHROPIC_MODEL ?? template.env?.GEMINI_MODEL ?? template.env?.CODEX_MODEL;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Parse `ps -o etime=` output (`[[dd-]hh:]mm:ss`) into milliseconds. */
function parseElapsed(text: string): number | null {
  const match = text.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, days = '0', hours = '0', minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000;
}

/**
 * Whether the process `pid` is the one that started at `startedAt`, as far as `ps` can tell.
 * A pid can be reused after a reboot or a long time; comparing start times keeps the pool
 * from adopting a stranger. Platforms without `ps` (Windows) answer true and rely on
 * liveness alone.
 */
function startedAround(pid: number, startedAt: string | undefined): boolean {
  if (!startedAt || process.platform === 'win32') return true;
  const result = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.status !== 0) return false;
  const elapsed = parseElapsed(result.stdout);
  if (elapsed === null) return true;
  const started = Date.now() - elapsed;
  return Math.abs(started - Date.parse(startedAt)) <= START_TIME_TOLERANCE_MS;
}

export class WorkerPool {
  private workers = new Map<string, WorkerInstance>();
  private followed = new Map<string, Followed>();
  /** FIFO history of exited worker instances; capped at RECENTLY_EXITED_MAX. */
  private recentlyExited: WorkerInstance[] = [];
  private backends = new Map<string, WorkerBackend>();
  private paused = false;
  private running = false;
  private taskCompletedCallback: TaskCompletedCallback | null = null;
  private taskProgressCallback: TaskProgressCallback | null = null;
  private taskUpdatedCallback: TaskUpdatedCallback | null = null;
  /**
   * Lazy-loaded role system prompt content, keyed by worker role.
   * Each entry: `null` = not yet attempted, `''` = loaded but missing /
   * empty (warned once), populated string = ready. On a missing file the
   * worker still runs without the role preamble — degraded behavior but
   * the cluster doesn't crash.
   */
  private rolePromptCache: Record<'planner' | 'coder', string | null> = {
    planner: null,
    coder: null,
  };

  constructor(
    private config: ClusterConfig,
    private hub: ContextHub,
  ) {}

  /**
   * Register a callback that fires when a worker exits and its task
   * reaches a terminal state. Idempotent — last setter wins.
   */
  setTaskCompletedCallback(cb: TaskCompletedCallback): void {
    this.taskCompletedCallback = cb;
  }

  /** Optional: observe new stdout while the process is still running. */
  setTaskProgressCallback(cb: TaskProgressCallback | null): void {
    this.taskProgressCallback = cb;
  }

  /** Persist a running task whose pid, log path or session id just became known. */
  setTaskUpdatedCallback(cb: TaskUpdatedCallback | null): void {
    this.taskUpdatedCallback = cb;
  }

  /**
   * Register a backend implementation.
   */
  registerBackend(backend: WorkerBackend): void {
    this.backends.set(backend.name, backend);
    logger.info(`[WorkerPool] Backend registered: ${backend.name}`);
  }

  /** Look up a registered backend by type. Used by probeWorkerTemplates. */
  getBackend(type: WorkerBackendType): WorkerBackend | undefined {
    return this.backends.get(type);
  }

  async start(): Promise<void> {
    this.running = true;
    mkdirSync(this.assignmentsDir, { recursive: true });
    mkdirSync(this.mcpDir, { recursive: true });
    logger.info(`[WorkerPool] Started (logs: ${this.assignmentsDir})`);
  }

  /**
   * Stop following the workers. They keep running: the scheduler that comes up next adopts
   * them by pid. `killWorkers` ends them instead, waiting for each to exit.
   */
  async stop(options?: { killWorkers?: boolean }): Promise<void> {
    this.running = false;

    if (options?.killWorkers) {
      const exits: Promise<void>[] = [];
      for (const worker of this.workers.values()) {
        exits.push(this.waitForExit(worker));
        void this.killWorkerInstance(worker);
      }
      await Promise.allSettled(exits);
      if (this.workers.size > 0) {
        logger.warn(`[WorkerPool] ${this.workers.size} worker(s) did not drain cleanly; force-clearing`);
      }
    } else {
      for (const worker of this.workers.values()) {
        const followed = this.followed.get(worker.id);
        if (followed) {
          followed.tail.stop();
          if (followed.liveness) clearInterval(followed.liveness);
        }
        logger.info(`[WorkerPool] Leaving worker ${worker.id} (pid ${worker.pid}) running`);
      }
    }

    this.workers.clear();
    this.followed.clear();
    this.recentlyExited = [];
    logger.info(options?.killWorkers ? '[WorkerPool] Stopped, all workers terminated' : '[WorkerPool] Stopped');
  }

  /**
   * Pause — stop accepting new tasks.
   */
  pause(): void {
    this.paused = true;
    logger.info('[WorkerPool] Paused');
  }

  /**
   * Resume accepting new tasks.
   */
  resume(): void {
    this.paused = false;
    logger.info('[WorkerPool] Resumed');
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Spawn a new worker for a task. The worker's role in WorkerRegistry is
   * derived from the template's `role` field: templates marked
   * `role: 'planner'` register as planner workers, everything else (including
   * templates with no role) registers as `coder`. The role is what gates
   * `hub_spawn` / `hub_query_task` / `hub_wait_task` access.
   */
  async spawnWorker(
    templateName: string,
    project: string,
    projectPath: string,
    task: TaskRecord,
    prepareWorkspace?: () => Promise<WorkerWorkspace>,
  ): Promise<WorkerInstance | null> {
    if (this.paused) {
      logger.warn('[WorkerPool] Pool is paused, not spawning');
      return null;
    }

    const template = this.config.workerTemplates[templateName];
    if (!template) {
      logger.error(`[WorkerPool] Unknown worker template: ${templateName}`);
      return null;
    }

    // Authoritative disable gate. Every spawn path (scheduler tryDispatch
    // and planner hub_spawn → submitChildTask) funnels through here, so a
    // template with `enabled: false` cannot be spawned no matter who asks.
    // Scheduler-side checks additionally avoid *selecting* disabled
    // templates so tasks don't get silently stuck; this is the last line.
    if (template.enabled === false) {
      logger.error(`[WorkerPool] Worker template "${templateName}" is disabled (enabled: false) — refusing to spawn`);
      return null;
    }

    const role: 'coder' | 'planner' = template.role === 'planner' ? 'planner' : 'coder';

    if (!this.canSpawnMore(templateName)) {
      logger.warn(`[WorkerPool] Cannot spawn more workers (limit reached)`);
      return null;
    }

    const backendType = template.type || 'claude-cli';
    const backend = this.backends.get(backendType);
    if (!backend) {
      logger.error(`[WorkerPool] No backend registered for type: ${backendType} (template "${templateName}")`);
      return null;
    }

    const workerId = `worker-${randomUUID().slice(0, 8)}`;
    const hubUrl = `http://${this.config.hub.host}:${this.config.hub.port}`;

    const workerInstance: WorkerInstance = {
      id: workerId,
      templateName,
      project,
      pid: null,
      child: null,
      logPath: null,
      status: 'starting',
      currentTask: task,
      startedAt: Date.now(),
      lastReport: Date.now(),
      lastStdoutActivity: Date.now(),
      nudgedAt: null,
    };

    // Registered before the first await: preparing a workspace can take minutes, and for all of
    // that time `canSpawnMore` must count this worker and a cancel must be able to reach it.
    this.workers.set(workerId, workerInstance);
    task.workerId = workerId;

    this.hub.workerRegistry.register(workerId, {
      role,
      project,
      templateName,
      jobId: task.jobId,
    });
    // Stamp the taskId onto the registration so hub_report can look it up
    // without requiring a prior hub_claim call.
    this.hub.workerRegistry.setTask(workerId, task.id);
    this.hub.eventLog.append('worker_joined', workerId, {
      template: templateName,
      project,
      taskId: task.id,
    });

    try {
      const mcpConfigPath = await this.generateMCPConfig(workerId, hubUrl);
      const workspace = await prepareWorkspace?.();
      if (workerInstance.status !== 'starting' || isTerminalTaskStatus(task.status)) {
        throw new Error('Worker stopped while its workspace was being prepared');
      }

      // Prepend the role-specific system prompt to the task description. We
      // mutate `taskPrompt` for the spawn call only — the persisted
      // TaskRecord.description is unchanged so the WebUI / DB still show the
      // user's original ticket text without the boilerplate.
      const rolePrompt = await this.loadRoleSystemPrompt(role, projectPath);
      // The planner prompt carries a {{CLUSTER_AVAILABLE_EXECUTORS}} token
      // rendered from live config so the planner's view of "which workers
      // exist and what they're for" can never drift from the configured set.
      const renderedRolePrompt =
        role === 'planner' && rolePrompt
          ? rolePrompt.replace(EXECUTOR_CATALOG_TOKEN, this.renderExecutorCatalog())
          : rolePrompt;
      const workspaceNote = workspace
        ? renderPrompt(
            await loadClusterPrompt(workspacePromptName(workspace), projectPath),
            workspacePromptVars(workspace),
          )
        : '';
      const effectivePrompt = [renderedRolePrompt, workspaceNote, task.description].filter(Boolean).join('\n\n');

      const launch = await backend.launch({
        workerId,
        taskPrompt: effectivePrompt,
        projectPath: workspace?.cwd ?? projectPath,
        mcpConfigPath,
        hubUrl,
        command: template.command,
        args: template.args,
        env: {
          ...(template.env || {}),
          ...workspace?.env,
          CLUSTER_WORKER_ID: workerId,
          CLUSTER_HUB_URL: hubUrl,
          CLUSTER_TASK_ID: task.id,
        },
        timeout: template.timeout,
      });

      const child = await this.startDetached(launch, task.id);
      workerInstance.pid = child.pid;
      workerInstance.child = child;
      workerInstance.logPath = this.outPath(task.id);
      workerInstance.status = 'running';
      task.workerPid = child.pid;
      task.workerStartedAt = new Date().toISOString();
      task.logPath = workerInstance.logPath;
      if (launch.sessionId) task.sessionId = launch.sessionId;
      task.model = templateModel(template);

      this.follow(workerInstance, backend, launch.cleanup);
      child.on('exit', (code) => void this.finalize(workerInstance, code));
      child.on('error', (err) => {
        logger.error(`[WorkerPool] Worker ${workerId} process error:`, err);
        void this.finalize(workerInstance, null, err.message);
      });

      logger.info(`[WorkerPool] Worker ${workerId} spawned for task ${task.id} (pid ${child.pid})`);
      return workerInstance;
    } catch (err) {
      logger.error(`[WorkerPool] Failed to spawn worker ${workerId}:`, err);
      this.workers.delete(workerId);
      this.hub.workerExited(workerId);
      // Surface the failure to the scheduler so the task transitions to
      // 'failed' instead of being stuck in 'pending' forever.
      if (this.taskCompletedCallback) {
        try {
          if (!isTerminalTaskStatus(task.status)) {
            task.status = 'failed';
            task.error = err instanceof Error ? err.message : String(err);
            task.completedAt = new Date().toISOString();
          }
          await this.taskCompletedCallback(task);
        } catch (cbErr) {
          logger.error(`[WorkerPool] taskCompletedCallback threw on spawn-failure path:`, cbErr);
        }
      }
      return null;
    }
  }

  /**
   * Pick up a task whose worker was started by an earlier scheduler process. Answers false
   * when the process is gone (or is not the one the task recorded), in which case the caller
   * ends the task.
   */
  adopt(task: TaskRecord): boolean {
    const { workerPid: pid, workerId } = task;
    if (!pid || !workerId) return false;
    if (!isAlive(pid) || !startedAround(pid, task.workerStartedAt)) {
      logger.info(`[WorkerPool] Worker ${workerId} (pid ${pid}) of task ${task.id} is gone; not adopting`);
      return false;
    }
    const template = this.config.workerTemplates[task.workerTemplate ?? ''];
    const backend = this.backends.get(template?.type || 'claude-cli');
    if (!backend) {
      logger.warn(
        `[WorkerPool] No backend for template "${task.workerTemplate}" of task ${task.id}; cannot follow worker ${workerId}`,
      );
      return false;
    }
    const worker: WorkerInstance = {
      id: workerId,
      templateName: task.workerTemplate ?? '',
      project: task.project,
      pid,
      child: null,
      logPath: task.logPath ?? this.outPath(task.id),
      status: 'running',
      currentTask: task,
      startedAt: task.workerStartedAt ? Date.parse(task.workerStartedAt) : Date.now(),
      lastReport: Date.now(),
      lastStdoutActivity: Date.now(),
      nudgedAt: null,
    };
    this.workers.set(workerId, worker);
    // Bind the worker to its task in the hub again: a hub_report that arrives after the
    // restart must still reach this task.
    this.hub.workerRegistry.register(workerId, {
      role: template?.role === 'planner' ? 'planner' : 'coder',
      project: task.project,
      templateName: worker.templateName,
      jobId: task.jobId,
    });
    this.hub.workerRegistry.setTask(workerId, task.id);
    this.follow(worker, backend, undefined);
    logger.info(`[WorkerPool] Adopted worker ${workerId} (pid ${pid}) for task ${task.id}`);
    return true;
  }

  /**
   * Kill a specific worker.
   */
  async killWorker(workerId: string): Promise<boolean> {
    const worker = this.workers.get(workerId);
    if (!worker) return false;

    await this.killWorkerInstance(worker);
    return true;
  }

  /**
   * Check if we can spawn more workers (global + per-template limits).
   */
  canSpawnMore(templateName?: string): boolean {
    const activeCount = this.getActiveCount();
    if (activeCount >= this.config.maxConcurrentWorkers) return false;

    if (templateName) {
      const template = this.config.workerTemplates[templateName];
      if (template) {
        const templateCount = Array.from(this.workers.values()).filter(
          (w) => w.templateName === templateName && w.status !== 'exited',
        ).length;
        if (templateCount >= template.maxConcurrent) return false;
      }
    }

    return true;
  }

  /** The worker's process is still ours to wait for, or has yet to start. */
  isWorkerLive(workerId: string): boolean {
    return this.workers.has(workerId);
  }

  /**
   * Get cluster status.
   */
  getStatus(): Omit<ClusterStatus, 'worktrees'> {
    const workers = Array.from(this.workers.values());
    const now = Date.now();

    return {
      running: this.running,
      paused: this.paused,
      activeWorkers: workers.filter((w) => w.status === 'running').length,
      idleWorkers: workers.filter((w) => w.status === 'idle').length,
      pendingTasks: 0, // filled by scheduler
      runningTasks: workers.filter((w) => w.status === 'running' && w.currentTask).length,
      completedTasks: 0, // filled by scheduler
      failedTasks: 0, // filled by scheduler
      workers: workers
        .filter((w) => w.status !== 'exited')
        .map((w) => ({
          id: w.id,
          template: w.templateName,
          project: w.project,
          status: w.status,
          currentTaskDescription: w.currentTask?.description,
          uptime: now - w.startedAt,
        })),
    };
  }

  /**
   * Get all live worker instances (excludes recently-exited history).
   */
  getWorkers(): WorkerInstance[] {
    return Array.from(this.workers.values());
  }

  /**
   * Get the FIFO history of recently-exited workers (most recent last).
   * Capped at RECENTLY_EXITED_MAX entries.
   */
  getHistory(): readonly WorkerInstance[] {
    return this.recentlyExited;
  }

  /**
   * Get active worker count.
   */
  getActiveCount(): number {
    return Array.from(this.workers.values()).filter((w) => w.status !== 'exited').length;
  }

  /**
   * Health check — two-phase stuck detection.
   *
   * Phase 1 (nudge): worker inactive for > timeoutMs but not yet nudged
   *   → scheduler should send a directive asking it to report.
   * Phase 2 (kill): worker was nudged but still inactive after graceMs
   *   → scheduler should kill it.
   */
  healthCheck(timeoutMs: number = 600_000, graceMs: number = 60_000): { nudge: string[]; kill: string[] } {
    const now = Date.now();
    const nudge: string[] = [];
    const kill: string[] = [];

    for (const worker of this.workers.values()) {
      if (worker.status !== 'running') continue;
      const lastActivity = Math.max(worker.lastReport, worker.lastStdoutActivity);
      if (now - lastActivity <= timeoutMs) continue;

      if (worker.nudgedAt === null) {
        logger.warn(
          `[WorkerPool] Worker ${worker.id} inactive — nudging (no hub_report for ${Math.round((now - worker.lastReport) / 1000)}s, no stdout for ${Math.round((now - worker.lastStdoutActivity) / 1000)}s)`,
        );
        nudge.push(worker.id);
      } else if (now - worker.nudgedAt > graceMs) {
        logger.warn(
          `[WorkerPool] Worker ${worker.id} unresponsive after nudge ${Math.round((now - worker.nudgedAt) / 1000)}s ago — marking for kill`,
        );
        kill.push(worker.id);
      }
    }

    return { nudge, kill };
  }

  /**
   * Send a nudge directive to a stale worker, asking it to confirm it's
   * still operational by calling hub_report. Sets nudgedAt so healthCheck
   * can track the grace period.
   */
  nudgeWorker(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    worker.nudgedAt = Date.now();
    const inactiveSec = Math.round((Date.now() - Math.max(worker.lastReport, worker.lastStdoutActivity)) / 1000);
    this.hub.messageBox.send(
      workerId,
      'hub',
      `⚠️ HEALTH CHECK: You have been inactive for ${inactiveSec}s with no hub_report or output. ` +
        'Please call hub_report(status="working", summary="<what you are doing>", nextSteps="<next step>") ' +
        'immediately to confirm you are still operational. Failure to respond will result in termination.',
      'directive',
      'warning',
    );
    logger.info(`[WorkerPool] Nudge directive sent to worker ${workerId}`);
  }

  /**
   * Update lastReport timestamp for a worker. Called from ContextHub on every
   * successful hub_report (via heartbeat callback) so healthCheck measures time
   * since last report, not time since process spawn.
   */
  updateLastReport(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.lastReport = Date.now();
      worker.nudgedAt = null;
    }
  }

  // ── Private ──

  private get assignmentsDir(): string {
    return join(this.config.stateDir, 'assignments');
  }

  private get mcpDir(): string {
    return join(this.config.stateDir, 'mcp');
  }

  private outPath(taskId: string): string {
    return join(this.assignmentsDir, `${taskId}.out.log`);
  }

  private errPath(taskId: string): string {
    return join(this.assignmentsDir, `${taskId}.err.log`);
  }

  /**
   * Start the worker in its own process group with its output on files. The parent's log
   * descriptors are closed right after the spawn: the child holds its own copies.
   */
  private async startDetached(launch: WorkerLaunch, taskId: string): Promise<ChildProcess & { pid: number }> {
    mkdirSync(this.assignmentsDir, { recursive: true });
    const out = openSync(this.outPath(taskId), 'a');
    const err = openSync(this.errPath(taskId), 'a');
    try {
      const child = spawnChild(launch.cmd[0], launch.cmd.slice(1), {
        cwd: launch.cwd,
        env: { ...process.env, ...launch.env },
        detached: true,
        stdio: [launch.stdin === undefined ? 'ignore' : 'pipe', out, err],
        windowsHide: true,
      });
      // A missing executable surfaces as an asynchronous `error` event on a child without a
      // pid; listen before anything else so it is reported, not thrown as unhandled.
      const failed = new Promise<Error>((resolve) => child.once('error', resolve));
      if (child.pid === undefined) {
        const error = await Promise.race([
          failed,
          new Promise<Error>((resolve) => setTimeout(() => resolve(new Error('spawn returned no pid')), 500)),
        ]);
        throw error;
      }
      if (launch.stdin !== undefined && child.stdin) {
        child.stdin.on('error', (e) => logger.warn(`[WorkerPool] stdin write failed for task ${taskId}:`, e));
        child.stdin.end(launch.stdin);
      }
      child.unref();
      return child as ChildProcess & { pid: number };
    } finally {
      closeSync(out);
      closeSync(err);
    }
  }

  /** Follow a worker's stdout file and, without a child handle, its liveness. */
  private follow(worker: WorkerInstance, backend: WorkerBackend, cleanup: (() => Promise<void>) | undefined): void {
    const task = worker.currentTask;
    const logPath = worker.logPath ?? this.outPath(task?.id ?? worker.id);
    let lastProgress = 0;
    let lastUsagePersist = 0;
    let modelConfirmed = false;
    const tail = new LogTail(
      logPath,
      (line) => {
        if (task && !task.sessionId && backend.sessionIdFrom) {
          const sessionId = backend.sessionIdFrom(line);
          if (sessionId) {
            task.sessionId = sessionId;
            this.taskUpdatedCallback?.(task);
          }
        }
        if (task && backend.usageFrom) {
          const sample = backend.usageFrom(line);
          if (sample) {
            task.usage = applyUsage(task.usage, sample);
            const now = Date.now();
            if (sample.final || now - lastUsagePersist >= USAGE_PERSIST_MS) {
              lastUsagePersist = now;
              this.taskUpdatedCallback?.(task);
            }
          }
        }
        if (task && backend.modelFrom && !modelConfirmed) {
          const model = backend.modelFrom(line);
          if (model) {
            modelConfirmed = true;
            if (task.model !== model) {
              task.model = model;
              this.taskUpdatedCallback?.(task);
            }
          }
        }
      },
      (text) => {
        worker.lastStdoutActivity = Date.now();
        worker.nudgedAt = null;
        if (!task) return;
        task.output = (task.output ?? '') + text;
        const now = Date.now();
        if (this.taskProgressCallback && now - lastProgress >= 2000) {
          lastProgress = now;
          Promise.resolve(this.taskProgressCallback(task)).catch((err) =>
            logger.warn(`[WorkerPool] taskProgressCallback threw for worker ${worker.id}:`, err),
          );
        }
      },
    );
    // An adopted worker's earlier output is already in the file: start from the beginning
    // so the in-memory `task.output` matches what a fresh scheduler would have seen.
    tail.start(worker.child === null);

    const liveness =
      worker.child === null && worker.pid !== null
        ? setInterval(() => {
            if (worker.pid !== null && !isAlive(worker.pid)) {
              void this.finalize(worker, null);
            }
          }, LIVENESS_POLL_MS)
        : null;

    this.followed.set(worker.id, {
      tail,
      errPath: this.errPath(task?.id ?? worker.id),
      liveness,
      cleanup,
      finalized: false,
    });
  }

  /**
   * The worker process is gone: read what it left, settle its task and tell the hub.
   * `exitCode` is null when the exit was observed by liveness polling (the process was not
   * our child) or when the spawn itself errored.
   */
  private async finalize(worker: WorkerInstance, exitCode: number | null, spawnError?: string): Promise<void> {
    const followed = this.followed.get(worker.id);
    if (followed?.finalized) return;
    if (followed) {
      followed.finalized = true;
      followed.tail.stop();
      if (followed.liveness) clearInterval(followed.liveness);
    }
    if (!this.workers.has(worker.id)) return;

    logger.info(`[WorkerPool] Worker ${worker.id} exited${exitCode === null ? '' : ` with code ${exitCode}`}`);

    let stderrOutput = '';
    if (followed && existsSync(followed.errPath)) {
      try {
        stderrOutput = readFileSync(followed.errPath, 'utf8');
      } catch {
        // Nothing to report.
      }
    }
    if (exitCode !== null && exitCode !== 0 && stderrOutput.trim()) {
      logger.warn(`[WorkerPool] Worker ${worker.id} stderr: ${stderrOutput.trim().slice(0, 2000)}`);
    }

    worker.status = 'exited';
    worker.child = null;
    this.hub.workerExited(worker.id);

    const task = worker.currentTask;
    if (task) {
      let rawOutput = task.output ?? '';
      if (worker.logPath && existsSync(worker.logPath)) {
        try {
          rawOutput = readFileSync(worker.logPath, 'utf8');
        } catch {
          // Keep what the tail collected.
        }
      }
      const backend = this.backends.get(this.config.workerTemplates[worker.templateName]?.type || 'claude-cli');
      let finalMessage = rawOutput;
      let rawEvents: unknown;
      if (backend?.parseOutput) {
        try {
          const parsed = backend.parseOutput(rawOutput);
          finalMessage = parsed.finalMessage;
          rawEvents = parsed.rawEvents;
        } catch (err) {
          logger.warn(
            `[WorkerPool] parseOutput threw for worker ${worker.id} (backend=${backend.name}); falling back to raw stdout:`,
            err,
          );
        }
      }
      task.output = finalMessage;
      // A terminal status set by hub_report stays authoritative: a SIGTERM exit code after a
      // voluntary `completed` report must not flip the task back to failed.
      if (!isTerminalTaskStatus(task.status)) {
        task.completedAt = new Date().toISOString();
        const lastReport = this.hub.workerRegistry.get(worker.id);
        if (spawnError) {
          task.status = 'failed';
          task.error = spawnError;
        } else if (lastReport?.lastReportStatus === 'blocked') {
          // A blocked report is not terminal while the worker lives, but it is the last word
          // once it exits: a clean exit must not turn stopped work into `completed` and land it.
          task.status = 'blocked';
          task.error = lastReport.lastReportSummary;
        } else if (exitCode === null) {
          task.status = 'failed';
          task.error = 'Worker process ended without a terminal hub_report';
        } else {
          task.status = exitCode === 0 ? 'completed' : 'failed';
          if (exitCode !== 0) {
            const stderrSuffix = stderrOutput.trim() ? `: ${stderrOutput.trim().slice(0, 1000)}` : '';
            task.error = `Process exited with code ${exitCode}${stderrSuffix}`;
          }
        }
      }
      if (rawEvents !== undefined) {
        try {
          task.metadata = JSON.stringify({ rawEvents });
        } catch {
          // Non-serializable events — drop silently, finalMessage is what matters.
        }
      }
    }

    this.recordExited(worker);
    this.followed.delete(worker.id);

    if (followed?.cleanup) {
      await followed.cleanup().catch((err) => logger.warn(`[WorkerPool] cleanup failed for worker ${worker.id}:`, err));
    }

    if (task && this.taskCompletedCallback) {
      try {
        await this.taskCompletedCallback(task);
      } catch (err) {
        logger.error(`[WorkerPool] taskCompletedCallback threw for worker ${worker.id}:`, err);
      }
    }
  }

  /** Resolve once the worker has left the live map (finalized), or after the force-cleanup window. */
  private waitForExit(worker: WorkerInstance): Promise<void> {
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (!this.workers.has(worker.id) || Date.now() - started > 10_000) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  }

  /**
   * Kill a worker with escalation + force-cleanup. The signal goes to the worker's process
   * group, so helpers it started (a shell, a test runner) end with it.
   *
   * Normal path: SIGTERM → exit event or liveness poll → `finalize`. A CLI that ignores
   * SIGTERM gets SIGKILL after 3 s; a worker whose exit is never observed is force-cleaned
   * after 8 s, relying on `finalize` being idempotent should the exit show up later.
   */
  private async killWorkerInstance(worker: WorkerInstance): Promise<void> {
    if (worker.status === 'stopping' || worker.status === 'exited') return;
    const preparing = worker.status === 'starting';
    worker.status = 'stopping';
    // No process yet: `spawnWorker` sees the status once the workspace is ready and winds the
    // worker down itself. Force-cleaning now would free a slot an install is still running in.
    if (preparing) return;

    const pid = worker.pid;
    const sendSignal = (signal: 'SIGTERM' | 'SIGKILL'): void => {
      if (pid === null) return;
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // Process already dead.
        }
      }
    };

    sendSignal('SIGTERM');

    const sigkillTimer = setTimeout(() => {
      if (!this.workers.has(worker.id)) return;
      logger.warn(`[WorkerPool] Worker ${worker.id} did not exit on SIGTERM; escalating to SIGKILL`);
      sendSignal('SIGKILL');
    }, 3000);

    const forceCleanupTimer = setTimeout(() => {
      if (!this.workers.has(worker.id)) return;
      logger.warn(`[WorkerPool] Worker ${worker.id} exit not observed after kill; force-cleaning state`);
      void this.forceCleanup(worker, 'Worker killed by user (force-cleaned after timeout)');
    }, 8000);

    void this.waitForExit(worker).then(() => {
      clearTimeout(sigkillTimer);
      clearTimeout(forceCleanupTimer);
    });
  }

  /**
   * Tear down a worker's state when its exit was never observed. Mirrors `finalize` and
   * relies on the same idempotency: if the exit shows up later, `finalize` finds nothing to do.
   */
  private async forceCleanup(worker: WorkerInstance, reason: string): Promise<void> {
    if (!this.workers.has(worker.id)) return;

    const followed = this.followed.get(worker.id);
    if (followed) {
      followed.finalized = true;
      followed.tail.stop();
      if (followed.liveness) clearInterval(followed.liveness);
      this.followed.delete(worker.id);
    }
    worker.status = 'exited';
    worker.child = null;
    this.hub.workerExited(worker.id);

    if (worker.currentTask) {
      const task = worker.currentTask;
      if (!isTerminalTaskStatus(task.status)) {
        task.status = 'failed';
        task.error = reason;
        task.completedAt = new Date().toISOString();
      }
    }

    this.recordExited(worker);

    if (worker.currentTask && this.taskCompletedCallback) {
      try {
        await this.taskCompletedCallback(worker.currentTask);
      } catch (err) {
        logger.error(`[WorkerPool] taskCompletedCallback threw during forceCleanup for ${worker.id}:`, err);
      }
    }
  }

  /**
   * Move a worker from the live `workers` map into the bounded
   * `recentlyExited` FIFO. Idempotent — calling twice for the same worker
   * is safe (second call is a no-op).
   */
  private recordExited(worker: WorkerInstance): void {
    if (!this.workers.has(worker.id)) return;
    this.workers.delete(worker.id);
    this.recentlyExited.push(worker);
    while (this.recentlyExited.length > RECENTLY_EXITED_MAX) {
      this.recentlyExited.shift();
    }
  }

  /**
   * Render the markdown table of executors a planner is allowed to
   * `hub_spawn`, straight from live config. Only executor-role (the
   * `role` default) templates that are not disabled appear — planners
   * can't spawn planners, and a disabled template must not be proposed.
   * Sorted cheapest-tier-first so the planner reads the low-cost options
   * before the expensive ones. Per-template `description` carries the
   * curated "what is this good at" guidance.
   */
  private renderExecutorCatalog(): string {
    const rows = Object.entries(this.config.workerTemplates)
      .filter(([, tpl]) => tpl.role !== 'planner' && tpl.enabled !== false)
      .sort(([, a], [, b]) => COST_TIER_ORDER[a.costTier] - COST_TIER_ORDER[b.costTier])
      .map(([name, tpl]) => {
        const desc = tpl.description?.trim() || tpl.capabilities.join(' / ') || '(无描述)';
        return `| \`${name}\` | ${tpl.costTier} | ${desc} |`;
      });

    if (rows.length === 0) {
      return '> ⚠️ 当前没有任何已启用的 executor template。无法 spawn，请 `hub_report({ status: "blocked" })` 并说明。';
    }

    return ['| Template | 成本 | 能力定位 & 适用场景 |', '|----------|------|---------------------|', ...rows].join(
      '\n',
    );
  }

  /**
   * Lazy-load the role-specific system prompt from disk and cache it.
   *
   * Resolution order (per role):
   *   1. `<projectPath>/prompts/cluster/<role>-system.md` — per-project override
   *   2. `<repoRoot>/prompts/cluster/<role>-system.md` — repo default
   *
   * If neither exists, returns empty string and logs once. The worker
   * still runs but without the role preamble.
   */
  private async loadRoleSystemPrompt(role: 'planner' | 'coder', projectPath: string): Promise<string> {
    const cached = this.rolePromptCache[role];
    if (cached !== null) return cached;

    const relativePath = ROLE_SYSTEM_PROMPT_PATHS[role];
    const candidates = [resolvePath(projectPath, relativePath), resolvePath(getRepoRoot(), relativePath)];
    for (const path of candidates) {
      try {
        const content = await readFile(path, 'utf-8');
        logger.info(`[WorkerPool] Loaded ${role} system prompt from ${path} (${content.length} chars)`);
        this.rolePromptCache[role] = content;
        return content;
      } catch {
        // try next candidate
      }
    }
    logger.warn(
      `[WorkerPool] ${role} system prompt not found at any candidate path: ${candidates.join(', ')}. ` +
        `${role} workers will run without a role preamble.`,
    );
    this.rolePromptCache[role] = '';
    return '';
  }

  /**
   * Write the MCP config file a claude worker reads with `--mcp-config`. The `url` carries
   * the `/mcp` suffix the hub mounts its transport on; the `X-Worker-Id` header goes out
   * with every request and is how the hub tells workers apart.
   */
  private async generateMCPConfig(workerId: string, hubUrl: string): Promise<string> {
    const mcpConfig = {
      mcpServers: {
        'cluster-context-hub': {
          type: 'http',
          url: `${hubUrl}/mcp`,
          headers: {
            'X-Worker-Id': workerId,
          },
        },
      },
    };

    mkdirSync(this.mcpDir, { recursive: true });
    const configPath = join(this.mcpDir, `${workerId}.json`);
    await writeFile(configPath, JSON.stringify(mcpConfig, null, 2));
    return configPath;
  }
}
