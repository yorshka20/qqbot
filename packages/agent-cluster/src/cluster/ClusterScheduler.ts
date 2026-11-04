/**
 * ClusterScheduler — core scheduling loop for the Agent Cluster.
 *
 * Continuously polls TaskSources, assigns tasks to workers via WorkerPool.
 */

import type { Database } from 'bun:sqlite';
import { logger, randomUUID } from '@qqbot/shared';
import type { ProjectEntry, ProjectRegistry } from '../codingAgent/ProjectRegistry';
import type { ClusterConfig } from './config';
import type { ContextHub } from './hub/ContextHub';
import type { TaskSource } from './sources/TaskSource';
import {
  type HubSubscribeInput,
  isJobLandable,
  isTerminalTaskStatus,
  type JobRecord,
  type JobStatus,
  type LandJobResult,
  type PlanningMode,
  type SubmitTaskOptions,
  type TaskCandidate,
  type TaskRecord,
  type TaskStatus,
} from './types';
import type { WorkerPool } from './WorkerPool';
import type { TaskWorkspaces } from './workspace/TaskWorkspaces';
import type { SlotKind, SlotLease } from './workspace/WorktreePool';

export class ClusterScheduler {
  private running = false;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private taskSources = new Map<string, TaskSource[]>(); // project → sources
  private activeTasks = new Map<string, TaskRecord>(); // taskId → record
  private jobs = new Map<string, JobRecord>(); // jobId → record
  /**
   * Project aliases for which we have already emitted an "unknown project"
   * warning. Prevents the scheduler loop from spamming logs every poll.
   * Reset on `start()` so config changes between cluster restarts are
   * still surfaced.
   */
  private warnedMissingProjects = new Set<string>();
  private jobCompletedCallback: ((job: JobRecord, tasks: TaskRecord[]) => void) | null = null;
  /** Tasks whose worker is gone and whose branch is landing, by task id. */
  private settling = new Map<string, Promise<void>>();
  private dispatchRunning = false;
  private dispatchRequested = false;

  constructor(
    private config: ClusterConfig,
    private hub: ContextHub,
    private workerPool: WorkerPool,
    private db: Database,
    private projectRegistry: ProjectRegistry,
    private workspaces: TaskWorkspaces,
  ) {}

  /**
   * Set a callback that fires when a job reaches terminal status.
   * Used for ticket result writeback.
   */
  setJobCompletedCallback(cb: (job: JobRecord, tasks: TaskRecord[]) => void): void {
    this.jobCompletedCallback = cb;
  }

  /**
   * Register task sources for a project.
   */
  registerSources(project: string, sources: TaskSource[]): void {
    this.taskSources.set(project, sources);
    logger.info(`[ClusterScheduler] Registered ${sources.length} sources for project "${project}"`);
  }

  /**
   * Start the scheduling loop.
   */
  async start(): Promise<void> {
    this.running = true;
    // Reset warn-once state so config changes between restarts surface again.
    this.warnedMissingProjects.clear();

    // Restore recent jobs from DB so the WebUI shows history after a restart, and pick up
    // the tasks whose workers are still running: workers are detached processes that
    // outlive the scheduler.
    this.restoreRecentFromDb();
    this.adoptRunningTasks();
    this.restoreQueuedChildren();
    await this.releaseOrphanedSlots();
    void this.dispatchPendingTasks();

    logger.info(`[ClusterScheduler] Started (interval: ${this.config.schedulingInterval}ms)`);
    this.scheduleNextRun();
  }

  /**
   * Mark a task as terminally completed (success or failure) and propagate
   * the new state through DB persistence + parent job counters + the
   * in-memory `activeTasks` map.
   *
   * Two callers go through here:
   *   1. `WorkerPool.taskCompletedCallback` on process exit (Phase 1 path)
   *   2. `ContextHub.reportCallback` on `hub_report({status: 'completed'|'failed'})`
   *      (Phase 2 round 2 path — the LLM voluntarily declares done)
   *
   * Both callers can fire for the same task in the same run: hub_report
   * usually arrives first because the LLM reports "done" before the
   * process actually exits. The second caller would otherwise double-count
   * job.tasksCompleted / tasksFailed. So we use `activeTasks.has(task.id)`
   * as the "first time through" gate for counter updates — but we still
   * `persistTask()` on every call so the exit path can refresh DB rows
   * (e.g. error text) after hub_report. Worker stdout is never persisted.
   *
   * Idempotency model:
   *   - persistTask: runs every call (SQLite UPSERT; stores summary/error only)
   *   - job counter update + activeTasks.delete: runs exactly once
   *
   * See docs/local/agent-cluster.md Issue D (original Phase 1 bug) and
   * §2.3 (hub_report wiring) for the full story.
   */
  markTaskCompleted(task: TaskRecord): void {
    this.finalizeTask(task);
  }

  /**
   * Terminal-state sequence shared by every path that moves a task out of
   * `activeTasks` for good: persist → job-counter update (once) →
   * activeTasks.delete → cascade-kill children. `markTaskCompleted` and
   * `cancelTask` both funnel through here so there is exactly one place
   * that owns the double-count guard below.
   *
   * Idempotency model:
   *   - persistTask: runs every call (SQLite UPSERT; stores summary/error only)
   *   - job counter update + activeTasks.delete: runs exactly once
   *
   * See docs/local/agent-cluster.md Issue D (original Phase 1 bug) and
   * §2.3 (hub_report wiring) for the full story.
   */
  private finalizeTask(task: TaskRecord): void {
    // Always persist — allows the post-exit code path to refresh error/diffSummary
    // after hub_report fired first. Stdout is never written to SQLite.
    this.persistTask(task);

    // A task in a slot is not over at its hub_report: the worker runs on until it exits and may
    // still commit, and the branch has yet to land, which can end the task as `blocked` instead.
    // So everything below waits for the exit, which brings the task back here.
    if (this.workspaces.holdsSlot(task.id)) {
      if (!task.workerId || !this.workerPool.isWorkerLive(task.workerId)) {
        this.settleWorkspace(task);
      }
      return;
    }

    // Whoever blocks in hub_wait on this task (its planner) wakes now, not on a poll.
    this.hub.taskSettled(task.id);

    // Job counter updates must happen exactly once per task. If the task
    // has already been removed from activeTasks, a prior call already
    // incremented the counters; skip them this time.
    if (!this.activeTasks.has(task.id)) {
      return;
    }

    this.hub.publishTaskOutcome(task);

    const job = this.jobs.get(task.jobId);
    // Only the root task (no parentTaskId) advances job-level counters.
    // A planner + its hub_spawn children share one jobId with taskCount=1;
    // counting every child completion would mark the job done as soon as
    // the first child finishes, which then cascade-kills its siblings.
    // Children's terminal state is still persisted via persistTask above.
    if (job && !task.parentTaskId) {
      if (task.status === 'completed') {
        job.tasksCompleted += 1;
      } else if (isTerminalTaskStatus(task.status)) {
        job.tasksFailed += 1;
      }
      const totalDone = job.tasksCompleted + job.tasksFailed;
      if (totalDone >= job.taskCount) {
        job.status = job.tasksFailed > 0 && job.tasksCompleted === 0 ? 'failed' : 'completed';
        job.completedAt = new Date().toISOString();
      }
      this.persistJob(job);

      // Fire writeback callback when job reaches terminal status
      if (job.status === 'completed' || job.status === 'failed') {
        this.fireJobCompletedCallback(job);
      }
    }

    // Drop from active map so the next scheduler tick won't see this task
    // as "in progress" via filterActionable().
    this.activeTasks.delete(task.id);

    // Phase 3 cascade-kill: if the task we just terminated has live
    // children, kill them. This happens whenever a planner exits (success
    // or failure) — we don't want orphan executors continuing to run after
    // their planner is gone, since their results would never be collected.
    //
    // We kick this off async because killing a worker waits for the
    // process exit and can take a moment, and we don't want to block the
    // synchronous markTaskCompleted path on it. The calling site is
    // already idempotent (see the activeTasks.has gate above), so the
    // late kill doesn't cause a re-entry.
    void this.cascadeKillChildren(task.id).catch((err) => {
      logger.error(`[ClusterScheduler] cascadeKillChildren failed for ${task.id}:`, err);
    });

    // A child may have been waiting for exactly this task.
    void this.dispatchPendingTasks();
  }

  private settleWorkspace(task: TaskRecord): void {
    if (this.settling.has(task.id)) {
      return;
    }
    const settled = this.workspaces
      .settle(task, this.jobs.get(task.jobId) ?? this.resolveJob(task.jobId))
      .catch((err) => logger.error(`[ClusterScheduler] Settling the workspace of task ${task.id} failed:`, err))
      .then(() => {
        this.settling.delete(task.id);
        this.finalizeTask(task);
        return this.dispatchPendingTasks();
      });
    this.settling.set(task.id, settled);
  }

  /** The task has ended and nothing about it can change any more. */
  isTaskSettled(taskId: string): boolean {
    const task = this.findTask(taskId);
    return task !== undefined && isTerminalTaskStatus(task.status) && !this.workspaces.holdsSlot(taskId);
  }

  /**
   * Operator-initiated cancel of a single task. Unlike cascade-kill (which
   * only fires as a side effect of a parent task terminating), this is the
   * only way to terminate a task that never got a worker at all — e.g. one
   * wedged `pending` forever because its resolved template is disabled.
   */
  async cancelTask(
    taskId: string,
    reason?: string,
  ): Promise<
    | { ok: true; cascadedChildren: number }
    | { ok: false; code: 'not_found' }
    | { ok: false; code: 'already_terminal'; status: TaskStatus }
  > {
    const task = this.findTask(taskId);
    if (!task) {
      return { ok: false, code: 'not_found' };
    }
    if (isTerminalTaskStatus(task.status)) {
      return { ok: false, code: 'already_terminal', status: task.status };
    }

    const cascaded = this.getChildTasks(taskId).filter(
      (c) => c.status === 'pending' || c.status === 'running' || c.status === 'claimed',
    ).length;

    task.status = 'cancelled';
    task.error = reason?.trim() || 'Cancelled by operator';
    task.completedAt = new Date().toISOString();
    this.finalizeTask(task);

    if (task.workerId) {
      try {
        await this.workerPool.killWorker(task.workerId);
      } catch (err) {
        logger.warn(`[ClusterScheduler] cancelTask: failed to kill worker ${task.workerId} for task ${taskId}:`, err);
      }
    }

    return { ok: true, cascadedChildren: cascaded };
  }

  /**
   * Operator-initiated cancel of every live task in a job. Cancels tasks
   * one at a time via `cancelTask` (reusing its worker-kill + cascade
   * logic) rather than duplicating that sequence, then forces the job
   * itself to `cancelled` — an explicit operator cancel always wins over
   * whatever terminal status `cancelTask`'s counter path may have already
   * derived for the job.
   */
  async cancelJob(
    jobId: string,
    reason?: string,
  ): Promise<
    | { ok: true; cancelledTasks: number }
    | { ok: false; code: 'not_found' }
    | { ok: false; code: 'already_terminal'; status: JobStatus }
  > {
    const job = this.getJob(jobId);
    if (!job) {
      return { ok: false, code: 'not_found' };
    }
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return { ok: false, code: 'already_terminal', status: job.status };
    }

    let cancelledTasks = 0;
    for (const task of this.getJobTasks(jobId)) {
      if (task.status !== 'pending' && task.status !== 'claimed' && task.status !== 'running') continue;
      const result = await this.cancelTask(task.id, reason);
      if (result.ok) cancelledTasks += 1;
    }

    job.status = 'cancelled';
    job.completedAt = new Date().toISOString();
    this.persistJob(job);

    return { ok: true, cancelledTasks };
  }

  /**
   * Phase 3: terminate every live child of `parentTaskId` and mark each
   * cancelled in the DB. Called from markTaskCompleted whenever a planner
   * task reaches terminal state. No-op if there are no children (the
   * common case for non-planner tasks).
   *
   * Why this is needed: a planner that exits leaves no one to collect its
   * children's results. Even if a child completes successfully, no
   * downstream code consumes its output — and a child that's still
   * running is just burning a worker slot. Cleanest behavior is to kill
   * everything in the subtree as soon as the parent terminates.
   *
   * Safe against the cascade hitting a child that's already terminal:
   * `getChildTasks` returns rows from both activeTasks and the DB
   * fallback, but `killWorker(workerId)` no-ops on workers that have
   * already exited, and `markTaskCompleted` (the path the kill triggers)
   * is idempotent.
   */
  private async cascadeKillChildren(parentTaskId: string): Promise<void> {
    const children = this.getChildTasks(parentTaskId);
    const liveChildren = children.filter(
      (c) => c.status === 'pending' || c.status === 'running' || c.status === 'claimed',
    );
    if (liveChildren.length === 0) return;

    logger.info(
      `[ClusterScheduler] Cascade-killing ${liveChildren.length} live child task(s) of terminated parent ${parentTaskId}`,
    );

    for (const child of liveChildren) {
      // Mark cancelled in DB so the WebUI shows a terminal state even if
      // the worker was never spawned (status='pending' children that
      // never made it past tryDispatch). LockManager is per-workerId so
      // killing the live worker handles its locks; pending children
      // never claimed any locks.
      child.status = 'cancelled';
      child.error = `Cancelled: parent task ${parentTaskId} terminated`;
      child.completedAt = new Date().toISOString();
      this.persistTask(child);
      this.activeTasks.delete(child.id);
      this.hub.taskSettled(child.id);

      if (child.workerId) {
        try {
          await this.workerPool.killWorker(child.workerId);
        } catch (err) {
          logger.warn(`[ClusterScheduler] Failed to kill worker ${child.workerId} for cascade child ${child.id}:`, err);
        }
      }
    }
  }

  /**
   * Land a job whose root task finished but whose work is not on the base branch: a landing that
   * failed, once its cause is gone, or a job from before jobs ended there.
   */
  async landJob(jobId: string): Promise<LandJobResult> {
    const job = this.resolveJob(jobId);
    const root = this.getJobTasks(jobId).find((task) => !task.parentTaskId);
    const entry = job && this.projectRegistry.resolve(job.project);
    if (!job || !root || !entry) {
      return { code: 'not_found' };
    }
    if (!isJobLandable(job, root)) {
      return { code: 'not_landable', reason: `Job ${jobId} has nothing waiting to land` };
    }
    const wasCompleted = root.status === 'completed';
    root.status = 'completed';
    root.error = undefined;
    job.landError = undefined;

    const landed = await this.workspaces.landAgain(root, job, entry);

    const completed = root.status === 'completed';
    if (completed !== wasCompleted) {
      job.tasksCompleted += completed ? 1 : -1;
      job.tasksFailed += completed ? -1 : 1;
    }
    job.status = completed ? 'completed' : 'failed';
    this.persistTask(root);
    this.persistJob(job);
    this.fireJobCompletedCallback(job);
    return { code: 'done', landed, error: root.error };
  }

  private fireJobCompletedCallback(job: JobRecord): void {
    if (!this.jobCompletedCallback) return;
    try {
      const tasks = this.getJobTasks(job.id);
      this.jobCompletedCallback(job, tasks);
    } catch (err) {
      logger.error(`[ClusterScheduler] jobCompletedCallback threw for job ${job.id}:`, err);
    }
  }

  /**
   * Look up a task currently tracked by the scheduler. Used by
   * `ContextHub.reportCallback` to resolve a taskId coming in via
   * `hub_report` to the live `TaskRecord` object the scheduler is managing.
   *
   * Returns `undefined` if the task has already been removed (terminal) or
   * was never scheduled through this ClusterScheduler instance.
   */
  getActiveTask(taskId: string): TaskRecord | undefined {
    return this.activeTasks.get(taskId);
  }

  /**
   * Called periodically while a worker is running. Previously persisted
   * partial stdout to DB every 2s — now a no-op on the DB side.
   * Intermediate output lives only in memory (worker.currentTask.output)
   * and is broadcast to WebUI via SSE by ClusterManager. The DB only
   * receives the final parsed summary on task completion.
   */
  flushRunningTaskOutput(_task: TaskRecord): void {
    // Intentional no-op: intermediate output is memory-only + SSE.
    // DB persistence happens in markTaskCompleted / persistTask after
    // parseOutput extracts the clean final message.
  }

  /** A durable field of a running task (pid, log path, session id) changed. */
  taskUpdated(task: TaskRecord): void {
    this.persistTask(task);
  }

  /** A person marked the task as seen; answers the stamp, or null when the task is unknown. */
  acknowledgeTask(taskId: string, at = new Date().toISOString()): string | null {
    const task = this.findTask(taskId);
    if (!task) return null;
    task.acknowledgedAt = at;
    this.persistTask(task);
    return at;
  }

  /**
   * Stop the scheduling loop.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    logger.info('[ClusterScheduler] Stopped');
  }

  /** Wait for branches that are landing. Workers killed on the way down get here after `stop()`, so this comes last. */
  async waitForSettling(): Promise<void> {
    await Promise.allSettled(this.settling.values());
  }

  /**
   * Manually submit a task. Creates a one-off job + task and immediately
   * tries to dispatch a worker for it (without waiting for the next
   * scheduling tick). If the worker pool is at capacity, the task stays
   * in `activeTasks` with status `pending` and is left for the user to
   * retry — Phase 1 does not auto-queue rejected manual submissions
   * because there is no manual-queue source separate from the task object
   * itself.
   *
   * Pre-Phase-1 versions of this method created the task and returned it
   * but never actually spawned a worker, leaving the task orphaned in
   * `activeTasks`. The e2e script (and the QQ `/cluster` command, and
   * `POST /api/cluster/jobs`) all depended on the spawn happening — see
   * docs/local/agent-cluster.md for the bug history.
   */
  async submitTask(project: string, description: string, options?: SubmitTaskOptions): Promise<TaskRecord | null> {
    const projectInfo = this.projectRegistry.resolve(project);
    if (!projectInfo) {
      this.warnUnknownProjectOnce(project);
      return null;
    }

    // Validate the optional template override BEFORE creating the job so a
    // typo doesn't leave a half-formed job sitting in the DB. Returning
    // null here is consistent with the "unknown project" path above.
    if (options?.workerTemplate && !this.config.workerTemplates[options.workerTemplate]) {
      logger.warn(
        `[ClusterScheduler] submitTask: unknown workerTemplate "${options.workerTemplate}". ` +
          `Available: ${Object.keys(this.config.workerTemplates).join(', ') || '(none)'}`,
      );
      return null;
    }
    if (options?.workerTemplate && this.config.workerTemplates[options.workerTemplate].enabled === false) {
      logger.warn(
        `[ClusterScheduler] submitTask: workerTemplate "${options.workerTemplate}" is disabled (enabled: false). ` +
          `Refusing to create an undispatchable task.`,
      );
      return null;
    }

    // Same guard for the no-explicit-template path: resolve the template
    // exactly as tryDispatch would (task.workerTemplate → workerPreference →
    // first declared) and reject up front if that resolution lands on a
    // disabled or missing template, so a submission can never produce a
    // task that tryDispatch will refuse forever.
    if (!options?.workerTemplate) {
      const projectConfig = this.config.projects[project];
      const resolvedName = projectConfig?.workerPreference || Object.keys(this.config.workerTemplates)[0];
      if (!resolvedName) {
        logger.warn(
          `[ClusterScheduler] submitTask: no workerPreference / workerTemplates configured for project "${project}"`,
        );
        return null;
      }
      if (this.config.workerTemplates[resolvedName]?.enabled === false) {
        logger.warn(
          `[ClusterScheduler] submitTask: resolved workerTemplate "${resolvedName}" (from workerPreference) is disabled ` +
            `(enabled: false). Refusing to create an undispatchable task — pick a different workerPreference for project "${project}".`,
        );
        return null;
      }
    }

    // Phase 3: requirePlannerRole is set by the dispatch caller when a
    // planner-role template is wanted (derived from the selected template's
    // role in the WebUI, or the --plannerMode flag in the CLI e2e tool).
    // We must select a planner-role template; if the explicit override is
    // an executor template, fail loudly rather than silently downgrade to a
    // single-worker run.
    if (options?.requirePlannerRole) {
      const explicit = options.workerTemplate ? this.config.workerTemplates[options.workerTemplate] : undefined;
      if (explicit && explicit.role !== 'planner') {
        logger.warn(
          `[ClusterScheduler] submitTask: requirePlannerRole=true but template "${options.workerTemplate}" has role "${explicit.role ?? 'executor'}". ` +
            `Refusing to dispatch — change the template or remove usePlanner.`,
        );
        return null;
      }
      // No explicit template → resolve via defaultPlannerTemplate or scan.
      if (!options.workerTemplate) {
        const fallback = this.resolvePlannerTemplate();
        if (!fallback) {
          logger.warn(
            `[ClusterScheduler] submitTask: requirePlannerRole=true but no planner-role template configured ` +
              `(set cluster.defaultPlannerTemplate or mark a workerTemplate with role: "planner")`,
          );
          return null;
        }
        options = { ...options, workerTemplate: fallback };
      }
    }

    // Create a one-off job for this manual submission.
    const jobId = randomUUID();
    const job: JobRecord = {
      id: jobId,
      project,
      description,
      status: 'pending',
      createdAt: new Date().toISOString(),
      taskCount: 1,
      planning: options?.planning ?? 'interactive',
      maxChildren: options?.maxChildren,
      tasksCompleted: 0,
      tasksFailed: 0,
      ticketId: options?.ticketId,
    };
    this.jobs.set(jobId, job);
    this.persistJob(job);

    const task = this.createTask(jobId, project, description, 'queue');
    if (options?.workerTemplate) {
      // Stash the override on the task so tryDispatch (now and on later
      // scheduler ticks if the initial dispatch is full) uses it instead
      // of falling back to projectConfig.workerPreference.
      task.workerTemplate = options.workerTemplate;
    }

    // Immediately try to dispatch — if the pool is full, the task stays
    // in `activeTasks` as `pending` and the next scheduling tick can
    // re-attempt it via dispatchPendingTasks().
    await this.tryDispatch(task, projectInfo);
    return task;
  }

  /**
   * Resolve the worker template name to use for a planner-mode dispatch
   * when the caller didn't specify one. Order of precedence:
   *   1. `cluster.defaultPlannerTemplate` from config (if it exists and is
   *      actually a planner-role template — defensive check against typos
   *      in config that point at an executor template)
   *   2. First template in `workerTemplates` declaration order whose
   *      role === 'planner'
   *
   * Returns `undefined` if no planner template exists at all — caller
   * should fail loudly rather than fall back to an executor template,
   * since usePlanner=true is an explicit user intent.
   */
  private resolvePlannerTemplate(): string | undefined {
    const explicit = this.config.defaultPlannerTemplate;
    if (explicit) {
      const tpl = this.config.workerTemplates[explicit];
      if (tpl?.role === 'planner' && tpl.enabled !== false) return explicit;
      logger.warn(
        `[ClusterScheduler] cluster.defaultPlannerTemplate "${explicit}" is missing, disabled, or not a planner-role template; scanning workerTemplates`,
      );
    }
    for (const [name, tpl] of Object.entries(this.config.workerTemplates)) {
      if (tpl.role === 'planner' && tpl.enabled !== false) return name;
    }
    return undefined;
  }

  /**
   * Try to spawn a worker for a single TaskRecord. Returns true on
   * successful spawn. Used by both `submitTask` (manual one-off) and
   * `runOnce` (source-driven candidates) so the dispatch logic
   * (template lookup → spawn → state mutation → persistTask) lives in
   * exactly one place.
   *
   * If `canSpawnMore` is false, the task is left untouched (status stays
   * `pending`) and false is returned — the caller decides whether to
   * retry on the next tick.
   */
  private async tryDispatch(task: TaskRecord, projectInfo: ProjectEntry): Promise<boolean> {
    if (!this.dependenciesLanded(task)) return false;

    // Template selection precedence:
    //   1. task.workerTemplate (pre-stamped by submitTask via the WebUI/API
    //      override or by a previous dispatch attempt)
    //   2. projectConfig.workerPreference
    //   3. first declared workerTemplate (last-resort fallback)
    const projectConfig = this.config.projects[task.project];
    const templateName =
      task.workerTemplate || projectConfig?.workerPreference || Object.keys(this.config.workerTemplates)[0];
    if (!templateName) {
      logger.warn(
        `[ClusterScheduler] No workerPreference / workerTemplates configured for project "${task.project}" — task ${task.id} cannot dispatch`,
      );
      return false;
    }

    // Don't dispatch onto a disabled template. The workerPreference /
    // first-declared fallback above can resolve to a disabled entry; if
    // we let it through, WorkerPool would refuse and the task would just
    // churn pending every tick with no clear reason. Surface it once and
    // leave the task pending until config / preference is fixed.
    if (this.config.workerTemplates[templateName]?.enabled === false) {
      logger.warn(
        `[ClusterScheduler] Resolved template "${templateName}" for task ${task.id} is disabled (enabled: false) — not dispatching. ` +
          `Pick a different workerPreference for project "${task.project}" or re-enable the template.`,
      );
      return false;
    }

    // Check both global and per-template concurrency limits before spawning.
    if (!this.workerPool.canSpawnMore(templateName)) return false;
    if (!this.childPlaceFree(task)) return false;

    const lease = this.claimWorkspace(task, templateName, projectInfo);
    if (lease === 'busy') return false;

    // Everything up to spawnWorker's registration of the worker runs synchronously, so a
    // concurrent dispatch sees this task as taken and counts its worker.
    task.status = 'claimed';
    task.claimedAt = new Date().toISOString();
    task.workerTemplate = templateName;
    this.persistTask(task);

    const spawned = this.spawnTaskWorker(task, templateName, projectInfo, lease);
    if (lease === null) return spawned;
    // Preparing a slot can include an install that takes minutes; hub_spawn and POST /jobs
    // answer now, and a failure reaches the task through the spawn-failure path.
    void spawned;
    return true;
  }

  /**
   * `maxChildren` bounds how many of a job's children run at once, not how many it ever had: a
   * child that ended gives its place back, however it ended, and the next one queued takes it.
   */
  private childPlaceFree(task: TaskRecord): boolean {
    const limit = task.parentTaskId ? this.jobOf(task)?.maxChildren : undefined;
    if (limit === undefined) return true;
    const running = this.getActiveTasks().filter(
      (t) => t.jobId === task.jobId && t.parentTaskId && (t.status === 'claimed' || t.status === 'running'),
    );
    return running.length < limit;
  }

  /**
   * A child starts from the integration tip, so it waits until everything it depends on is there.
   * A dependency that ended any other way will never land: the child ends too, which wakes its
   * planner to decide what happens next.
   */
  private dependenciesLanded(task: TaskRecord): boolean {
    for (const dependencyId of this.hub.taskDependencies(task.id)) {
      if (!this.isTaskSettled(dependencyId)) return false;
      const status = this.findTask(dependencyId)?.status;
      if (status !== 'completed') {
        task.status = 'cancelled';
        task.error = `Not started: dependency ${dependencyId} ended ${status}`;
        task.completedAt = new Date().toISOString();
        this.finalizeTask(task);
        return false;
      }
    }
    return true;
  }

  /** The slot this task runs in: null when it runs in the project checkout, `busy` when it must wait for one. */
  private claimWorkspace(task: TaskRecord, templateName: string, projectInfo: ProjectEntry): SlotLease | 'busy' | null {
    // A planner started before worktree pools existed expects its children in the checkout it
    // reads; its job stays there until it settles.
    const parent = task.parentTaskId ? this.findTask(task.parentTaskId) : undefined;
    if (parent && !parent.worktreePath) return null;

    const claim = this.workspaces.claim(task, projectInfo, this.slotKind(templateName));
    return claim === 'unpooled' ? null : claim;
  }

  private jobOf(task: TaskRecord): JobRecord | undefined {
    return this.jobs.get(task.jobId) ?? this.resolveJob(task.jobId);
  }

  private slotKind(templateName: string): SlotKind {
    return this.config.workerTemplates[templateName]?.role === 'planner' ? 'planner' : 'executor';
  }

  private async spawnTaskWorker(
    task: TaskRecord,
    templateName: string,
    projectInfo: ProjectEntry,
    lease: SlotLease | null,
  ): Promise<boolean> {
    const worker = await this.workerPool.spawnWorker(
      templateName,
      task.project,
      projectInfo.path,
      task,
      lease
        ? () => this.prepareWorkspace(task, projectInfo, lease)
        : async () => this.workspaces.unpooled(projectInfo, this.slotKind(templateName), this.jobOf(task)),
    );
    if (worker) {
      task.status = isTerminalTaskStatus(task.status) ? task.status : 'running';
      task.startedAt = new Date().toISOString();
      this.persistTask(task);
      return true;
    }
    // Refused before it started; a failure while starting already ended the task.
    if (task.status === 'claimed') {
      task.status = 'pending';
      task.claimedAt = undefined;
      this.persistTask(task);
      if (lease) await this.workspaces.release(lease);
    }
    return false;
  }

  private async prepareWorkspace(task: TaskRecord, projectInfo: ProjectEntry, lease: SlotLease) {
    const job = this.jobs.get(task.jobId) ?? this.resolveJob(task.jobId);
    if (!job) {
      throw new Error(`Job ${task.jobId} of task ${task.id} not found`);
    }
    const workspace = await this.workspaces.prepare(task, job, projectInfo, lease);
    this.persistJob(job);
    this.persistTask(task);
    return workspace;
  }

  /**
   * Get all active tasks.
   */
  getActiveTasks(): TaskRecord[] {
    return Array.from(this.activeTasks.values());
  }

  /**
   * Get all jobs.
   */
  getJobs(opts?: { status?: string; limit?: number; offset?: number }): JobRecord[] {
    let results = Array.from(this.jobs.values());
    if (opts?.status) {
      results = results.filter((j) => j.status === opts.status);
    }
    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const offset = opts?.offset || 0;
    const limit = opts?.limit || 50;
    return results.slice(offset, offset + limit);
  }

  /**
   * Get a specific job.
   */
  getJob(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Paginated job history directly from DB (includes all historical jobs,
   * not just those in the recent in-memory window).
   */
  getJobsFromDb(opts: { limit: number; offset: number; status?: string }): {
    items: JobRecord[];
    total: number;
    hasMore: boolean;
  } {
    try {
      const conditions: string[] = [];
      const params: any[] = [];
      if (opts.status) {
        conditions.push('status = ?');
        params.push(opts.status);
      }
      const where = conditions.length > 0 ? conditions.join(' AND ') : '1=1';

      const countRow = this.db.query(`SELECT COUNT(*) as cnt FROM cluster_jobs WHERE ${where}`).get(...params) as any;
      const total = countRow?.cnt ?? 0;

      const rows = this.db
        .query(`SELECT * FROM cluster_jobs WHERE ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`)
        .all(...params, opts.limit, opts.offset) as Array<Record<string, unknown>>;

      const items = rows.map((row) => this.rowToJob(row));
      return { items, total, hasMore: opts.offset + rows.length < total };
    } catch (err) {
      logger.error('[ClusterScheduler] getJobsFromDb failed:', err);
      return { items: [], total: 0, hasMore: false };
    }
  }

  /**
   * Job by id — in-memory first, then `cluster_jobs` (for ticketId after the
   * job row aged out of the live map or across hub-only lookups).
   */
  resolveJob(jobId: string): JobRecord | undefined {
    const live = this.jobs.get(jobId);
    if (live) {
      return live;
    }
    try {
      const row = this.db.query(`SELECT * FROM cluster_jobs WHERE id = ? LIMIT 1`).get(jobId) as Record<
        string,
        unknown
      > | null;
      if (!row) {
        return undefined;
      }
      return this.rowToJob(row);
    } catch (err) {
      logger.warn(`[ClusterScheduler] resolveJob DB lookup failed for ${jobId}:`, err);
      return undefined;
    }
  }

  /**
   * Get tasks for a specific job. Returns the union of:
   *   - live entries in `activeTasks` (in-progress / pending)
   *   - persisted rows in `cluster_tasks` for the same jobId (completed,
   *     failed, cascade-cancelled)
   *
   * Phase 3: a planner job can have many children that all share the
   * planner's jobId. The DB fallback is what lets the WebUI render the
   * full task tree after the planner has terminated and its children
   * have been drained from `activeTasks`. Pre-Phase-3 the
   * activeTasks-only result was sufficient because each job had exactly
   * one task; that's no longer true.
   */
  getJobTasks(jobId: string): TaskRecord[] {
    const live = Array.from(this.activeTasks.values()).filter((t) => t.jobId === jobId);
    const liveIds = new Set(live.map((t) => t.id));
    try {
      const rows = this.db
        .query(`SELECT * FROM cluster_tasks WHERE jobId = ? ORDER BY createdAt ASC`)
        .all(jobId) as Array<Record<string, unknown>>;
      const fromDb: TaskRecord[] = [];
      for (const row of rows) {
        if (liveIds.has(row.id as string)) continue;
        fromDb.push(this.rowToTask(row));
      }
      return [...live, ...fromDb];
    } catch (err) {
      logger.warn(`[ClusterScheduler] getJobTasks DB scan failed for ${jobId}:`, err);
      return live;
    }
  }

  // ── Private ──

  private scheduleNextRun(): void {
    if (!this.running) return;
    this.loopTimer = setTimeout(async () => {
      try {
        await this.runOnce();
      } catch (err) {
        logger.error('[ClusterScheduler] Loop error:', err);
      }
      this.scheduleNextRun();
    }, this.config.schedulingInterval);
  }

  private async runOnce(): Promise<void> {
    if (this.workerPool.isPaused()) return;

    // 1. Collect tasks from all sources
    const candidates = await this.collectTasks();

    // 2. Filter actionable (not already being worked on)
    const actionable = this.filterActionable(candidates);

    // 3. Sort by priority
    const sorted = actionable.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    // 4. Assign to workers via the shared dispatch helper.
    for (const candidate of sorted) {
      if (!this.workerPool.canSpawnMore()) break;

      const projectInfo = this.projectRegistry.resolve(candidate.project);
      if (!projectInfo) {
        this.warnUnknownProjectOnce(candidate.project);
        continue;
      }

      // Source-driven candidates each get their own one-off job.
      const jobId = randomUUID();
      const job: JobRecord = {
        id: jobId,
        project: candidate.project,
        description: candidate.description,
        status: 'running',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        taskCount: 1,
        planning: 'auto',
        tasksCompleted: 0,
        tasksFailed: 0,
      };
      this.jobs.set(jobId, job);
      this.persistJob(job);

      const task = this.createTask(jobId, candidate.project, candidate.description, candidate.source);
      await this.tryDispatch(task, projectInfo);
    }

    // 5. Re-attempt any pending tasks from prior submitTask() calls that
    //    couldn't dispatch immediately because the pool was full.
    await this.dispatchPendingTasks();

    // 6. Health check — two-phase: nudge first, kill only after grace period
    const { nudge, kill } = this.workerPool.healthCheck();
    for (const workerId of nudge) {
      this.workerPool.nudgeWorker(workerId);
    }
    for (const workerId of kill) {
      logger.warn(`[ClusterScheduler] Killing unresponsive worker (nudge ignored): ${workerId}`);
      await this.workerPool.killWorker(workerId);
    }
  }

  /**
   * Give waiting tasks a worker. Runs whenever capacity may have appeared: a slot was freed, or
   * the scheduling tick. A call that arrives during a pass asks for one more pass, so nothing
   * freed meanwhile is missed.
   */
  private async dispatchPendingTasks(): Promise<void> {
    if (this.dispatchRunning) {
      this.dispatchRequested = true;
      return;
    }
    this.dispatchRunning = true;
    try {
      do {
        this.dispatchRequested = false;
        if (!this.running || this.workerPool.isPaused()) return;
        for (const task of Array.from(this.activeTasks.values())) {
          if (task.status !== 'pending') continue;
          if (!this.workerPool.canSpawnMore()) break;
          const projectInfo = this.projectRegistry.resolve(task.project);
          if (!projectInfo) continue;
          await this.tryDispatch(task, projectInfo);
        }
      } while (this.dispatchRequested);
    } finally {
      this.dispatchRunning = false;
    }
  }

  private async collectTasks(): Promise<TaskCandidate[]> {
    const all: TaskCandidate[] = [];

    for (const [project, sources] of this.taskSources) {
      const projectInfo = this.projectRegistry.resolve(project);
      if (!projectInfo) {
        this.warnUnknownProjectOnce(project);
        continue;
      }

      for (const source of sources) {
        try {
          const candidates = await source.poll(projectInfo);
          all.push(...candidates);
        } catch (err) {
          logger.warn(`[ClusterScheduler] Source ${source.name} failed for ${project}:`, err);
        }
      }
    }

    return all;
  }

  /**
   * Emit a warning about an unknown project alias at most once per scheduler
   * lifetime. Used by both `collectTasks()` and the per-candidate spawn path
   * in `runOnce()` to avoid log spam when a misconfigured project is polled
   * every scheduling interval.
   */
  private warnUnknownProjectOnce(project: string): void {
    if (this.warnedMissingProjects.has(project)) return;
    this.warnedMissingProjects.add(project);
    logger.warn(
      `[ClusterScheduler] Unknown project "${project}" — not registered in the projectRegistry config. ` +
        `Tasks for this project will be skipped. Check the cluster.projects keys against the project registry.`,
    );
  }

  /**
   * Pre-flight project alias validation. Called by `ClusterManager.start()`
   * after the scheduler is ready but before the first scheduling tick, so
   * misconfigured aliases produce a single up-front error log instead of
   * silent skips later. Returns the list of missing aliases for the caller
   * to surface (e.g. to the WebUI control plane).
   */
  validateProjects(): string[] {
    const missing: string[] = [];
    for (const alias of Object.keys(this.config.projects)) {
      if (!this.projectRegistry.resolve(alias)) {
        missing.push(alias);
      }
    }
    if (missing.length > 0) {
      logger.error(
        `[ClusterScheduler] Project alias validation failed: ${missing.join(', ')}. ` +
          `These cluster projects are NOT registered in the projectRegistry config — ` +
          `tasks for them will be skipped until you fix the config.`,
      );
      // Pre-seed warnedMissingProjects so the runtime warn-once path doesn't
      // re-warn these immediately on the first tick.
      for (const alias of missing) this.warnedMissingProjects.add(alias);
    }
    return missing;
  }

  private filterActionable(candidates: TaskCandidate[]): TaskCandidate[] {
    // Filter out tasks already being worked on (by description match)
    const activeDescriptions = new Set<string>();
    for (const task of this.activeTasks.values()) {
      if (task.status === 'running' || task.status === 'claimed') {
        activeDescriptions.add(task.description);
      }
    }
    return candidates.filter((c) => !activeDescriptions.has(c.description));
  }

  private createTask(jobId: string, project: string, description: string, source: TaskCandidate['source']): TaskRecord {
    const task: TaskRecord = {
      id: randomUUID(),
      jobId,
      project,
      description,
      status: 'pending',
      source,
      createdAt: new Date().toISOString(),
    };
    this.activeTasks.set(task.id, task);
    this.persistTask(task);
    return task;
  }

  private persistJob(job: JobRecord): void {
    try {
      this.db
        .query(
          `INSERT OR REPLACE INTO cluster_jobs
         (id, project, description, status, createdAt, startedAt, completedAt, taskCount, tasksCompleted, tasksFailed, metadata, ticketId, integrationBranch, planning, baseBranch, landedAt, landError, maxChildren)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          job.id,
          job.project,
          job.description,
          job.status,
          job.createdAt,
          job.startedAt ?? null,
          job.completedAt ?? null,
          job.taskCount,
          job.tasksCompleted,
          job.tasksFailed,
          job.metadata ?? null,
          job.ticketId ?? null,
          job.integrationBranch ?? null,
          job.planning,
          job.baseBranch ?? null,
          job.landedAt ?? null,
          job.landError ?? null,
          job.maxChildren ?? null,
        );
    } catch (err) {
      logger.error('[ClusterScheduler] Failed to persist job:', err);
    }
  }

  private persistTask(task: TaskRecord): void {
    try {
      // Never persist worker stdout / metadata — only full hub_report summary (`diffSummary`) and error.
      const diffSummaryForDb = task.diffSummary ?? null;
      const errorForDb = task.error ?? null;

      this.db
        .query(
          `INSERT OR REPLACE INTO cluster_tasks
         (id, jobId, project, description, status, workerId, workerTemplate, source,
          createdAt, claimedAt, startedAt, completedAt, output, error, filesModified, diffSummary, metadata, parentTaskId,
          workerPid, workerStartedAt, logPath, sessionId, acknowledgedAt, model, usage,
          branch, worktreePath, mergedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          task.id,
          task.jobId,
          task.project,
          task.description,
          task.status,
          task.workerId ?? null,
          task.workerTemplate ?? null,
          task.source,
          task.createdAt,
          task.claimedAt ?? null,
          task.startedAt ?? null,
          task.completedAt ?? null,
          null,
          errorForDb,
          task.filesModified ?? null,
          diffSummaryForDb,
          null,
          task.parentTaskId ?? null,
          task.workerPid ?? null,
          task.workerStartedAt ?? null,
          task.logPath ?? null,
          task.sessionId ?? null,
          task.acknowledgedAt ?? null,
          task.model ?? null,
          task.usage ? JSON.stringify(task.usage) : null,
          task.branch ?? null,
          task.worktreePath ?? null,
          task.mergedAt ?? null,
        );
    } catch (err) {
      logger.error('[ClusterScheduler] Failed to persist task:', err);
    }
  }

  /**
   * Look up child tasks of a given parent. Used by:
   *   - Phase 3 cascade-kill: when a planner task transitions to terminal,
   *     ClusterManager queries this to find executor children that need
   *     killing so they don't continue running orphaned.
   *   - Phase 3 hub_query_task safety check: ContextHub validates that the
   *     querying planner is the parent of the task it's asking about.
   *
   * Reads from `activeTasks` first (live, includes pending/running children),
   * then falls back to a DB scan for children that already reached terminal
   * status and were dropped from the in-memory map. Both paths are needed:
   * cascade-kill operates on live workers, but query/wait can race against
   * a child that just completed.
   */
  getChildTasks(parentTaskId: string): TaskRecord[] {
    const live = Array.from(this.activeTasks.values()).filter((t) => t.parentTaskId === parentTaskId);
    const liveIds = new Set(live.map((t) => t.id));
    try {
      const rows = this.db.query(`SELECT * FROM cluster_tasks WHERE parentTaskId = ?`).all(parentTaskId) as Array<
        Record<string, unknown>
      >;
      const fromDb: TaskRecord[] = [];
      for (const row of rows) {
        const id = row.id as string;
        if (liveIds.has(id)) continue;
        fromDb.push(this.rowToTask(row));
      }
      return [...live, ...fromDb];
    } catch (err) {
      logger.warn('[ClusterScheduler] getChildTasks DB scan failed (returning live only):', err);
      return live;
    }
  }

  /**
   * Look up a single task by id, falling back to DB if it isn't in
   * `activeTasks`. Used by Phase 3 `hub_query_task` so a planner can poll
   * a child task that has already completed (and thus been removed from
   * the active map by markTaskCompleted).
   */
  findTask(taskId: string): TaskRecord | undefined {
    const live = this.activeTasks.get(taskId);
    if (live) return live;
    try {
      const row = this.db.query(`SELECT * FROM cluster_tasks WHERE id = ? LIMIT 1`).get(taskId) as Record<
        string,
        unknown
      > | null;
      if (!row) return undefined;
      return this.rowToTask(row);
    } catch (err) {
      logger.warn(`[ClusterScheduler] findTask DB lookup failed for ${taskId}:`, err);
      return undefined;
    }
  }

  /**
   * Latest persisted/live task row for a worker id (WebUI worker card enrichment
   * when `lastBoundTaskId` is missing on older registrations).
   */
  findLatestTaskForWorker(workerId: string): TaskRecord | undefined {
    const live = Array.from(this.activeTasks.values()).find((t) => t.workerId === workerId);
    if (live) {
      return live;
    }
    try {
      const row = this.db
        .query(`SELECT * FROM cluster_tasks WHERE workerId = ? ORDER BY COALESCE(startedAt, createdAt) DESC LIMIT 1`)
        .get(workerId) as Record<string, unknown> | null;
      if (!row) {
        return undefined;
      }
      return this.rowToTask(row);
    } catch (err) {
      logger.warn(`[ClusterScheduler] findLatestTaskForWorker failed for ${workerId}:`, err);
      return undefined;
    }
  }

  /**
   * Hydrate in-memory `jobs` map from the DB so WebUI can show recent
   * history after a cluster restart. Only loads jobs from the last 7 days.
   * Tasks are NOT loaded into `activeTasks` (they are fetched on-demand
   * via `getJobTasks` which already does a DB fallback). This avoids
   * accidentally re-dispatching completed work.
   */
  private restoreRecentFromDb(): void {
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
      const rows = this.db
        .query(`SELECT * FROM cluster_jobs WHERE createdAt >= ? ORDER BY createdAt DESC LIMIT 200`)
        .all(cutoff) as Array<Record<string, unknown>>;

      let restored = 0;
      for (const row of rows) {
        const id = row.id as string;
        if (this.jobs.has(id)) continue; // already in memory (shouldn't happen on fresh start)
        this.jobs.set(id, this.rowToJob(row));
        restored++;
      }
      if (restored > 0) {
        logger.info(`[ClusterScheduler] Restored ${restored} recent job(s) from DB`);
      }
    } catch (err) {
      logger.warn('[ClusterScheduler] restoreRecentFromDb failed (non-fatal):', err);
    }
  }

  /**
   * Re-attach to the workers an earlier scheduler process started. A task whose worker is
   * gone ends as failed here, with whatever hub_report left in the DB kept intact.
   *
   * A task still holding a slot is picked up whatever its status: it may have reported
   * `completed` with its worker still running, or the daemon may have stopped before its
   * branch landed. Either way, losing it would leak the slot and drop the merge. A `claimed`
   * task with no pid was stopped mid-preparation and has no worker to adopt.
   */
  private adoptRunningTasks(): void {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = this.db
        .query(
          `SELECT * FROM cluster_tasks
           WHERE (status = 'running' AND workerPid IS NOT NULL)
              OR status = 'claimed'
              OR id IN (SELECT taskId FROM cluster_worktree_slots WHERE taskId IS NOT NULL)`,
        )
        .all() as Array<Record<string, unknown>>;
    } catch (err) {
      logger.warn('[ClusterScheduler] adoptRunningTasks query failed (non-fatal):', err);
      return;
    }
    let adopted = 0;
    for (const row of rows) {
      const task = this.rowToTask(row);
      if (!this.jobs.has(task.jobId)) {
        const job = this.getJob(task.jobId) ?? this.resolveJob(task.jobId);
        if (job) this.jobs.set(job.id, job);
      }
      this.activeTasks.set(task.id, task);
      if (this.workerPool.adopt(task)) {
        adopted++;
        continue;
      }
      if (!isTerminalTaskStatus(task.status)) {
        task.status = 'failed';
        task.error = 'Worker process not found after scheduler restart';
        task.completedAt = new Date().toISOString();
      }
      this.finalizeTask(task);
    }
    if (rows.length > 0) {
      logger.info(`[ClusterScheduler] Adopted ${adopted} running worker(s); ${rows.length - adopted} ended as failed`);
    }
  }

  /** A child still waiting for a slot keeps waiting across a restart, or its planner would wait forever. */
  private restoreQueuedChildren(): void {
    const parents = Array.from(this.activeTasks.keys());
    if (parents.length === 0) return;
    const rows = this.db
      .query(
        `SELECT * FROM cluster_tasks WHERE status = 'pending' AND parentTaskId IN (${parents.map(() => '?').join(', ')})`,
      )
      .all(...parents) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const task = this.rowToTask(row);
      this.activeTasks.set(task.id, task);
    }
  }

  /** A lease whose task the database no longer knows has no one left to return it. */
  private async releaseOrphanedSlots(): Promise<void> {
    for (const lease of this.workspaces.leases()) {
      if (!this.findTask(lease.taskId)) {
        logger.warn(`[ClusterScheduler] Releasing slot ${lease.path}: task ${lease.taskId} is unknown`);
        await this.workspaces.release(lease);
      }
    }
  }

  private rowToJob(row: Record<string, unknown>): JobRecord {
    return {
      id: row.id as string,
      project: row.project as string,
      description: row.description as string,
      status: row.status as JobRecord['status'],
      createdAt: row.createdAt as string,
      startedAt: (row.startedAt as string | null) ?? undefined,
      completedAt: (row.completedAt as string | null) ?? undefined,
      taskCount: Number(row.taskCount),
      tasksCompleted: Number(row.tasksCompleted),
      tasksFailed: Number(row.tasksFailed),
      metadata: (row.metadata as string | null) ?? undefined,
      ticketId: (row.ticketId as string | null) ?? undefined,
      integrationBranch: (row.integrationBranch as string | null) ?? undefined,
      planning: (row.planning as PlanningMode | null) ?? 'auto',
      baseBranch: (row.baseBranch as string | null) ?? undefined,
      landedAt: (row.landedAt as string | null) ?? undefined,
      landError: (row.landError as string | null) ?? undefined,
      maxChildren: (row.maxChildren as number | null) ?? undefined,
    };
  }

  private rowToTask(row: Record<string, unknown>): TaskRecord {
    return {
      id: row.id as string,
      jobId: row.jobId as string,
      project: row.project as string,
      description: row.description as string,
      status: row.status as TaskRecord['status'],
      workerId: (row.workerId as string | null) ?? undefined,
      workerTemplate: (row.workerTemplate as string | null) ?? undefined,
      source: (row.source as TaskRecord['source']) ?? 'queue',
      createdAt: row.createdAt as string,
      claimedAt: (row.claimedAt as string | null) ?? undefined,
      startedAt: (row.startedAt as string | null) ?? undefined,
      completedAt: (row.completedAt as string | null) ?? undefined,
      output: (row.output as string | null) ?? undefined,
      error: (row.error as string | null) ?? undefined,
      filesModified: (row.filesModified as string | null) ?? undefined,
      diffSummary: (row.diffSummary as string | null) ?? undefined,
      metadata: (row.metadata as string | null) ?? undefined,
      parentTaskId: (row.parentTaskId as string | null) ?? undefined,
      workerPid: (row.workerPid as number | null) ?? undefined,
      workerStartedAt: (row.workerStartedAt as string | null) ?? undefined,
      logPath: (row.logPath as string | null) ?? undefined,
      sessionId: (row.sessionId as string | null) ?? undefined,
      acknowledgedAt: (row.acknowledgedAt as string | null) ?? undefined,
      model: (row.model as string | null) ?? undefined,
      usage: parseUsage(row.usage),
      branch: (row.branch as string | null) ?? undefined,
      worktreePath: (row.worktreePath as string | null) ?? undefined,
      mergedAt: (row.mergedAt as string | null) ?? undefined,
    };
  }

  /**
   * Phase 3: submit a child task spawned by a planner via `hub_spawn`.
   *
   * Differs from `submitTask` (the root-task path) in three ways:
   *   1. Caller passes the explicit `parentTaskId` so the parent-child link
   *      gets stamped into both the in-memory record and the persisted row.
   *   2. The child reuses the parent's jobId — a planner + its children
   *      together count as one "job" from the user's POV (one ticket =
   *      one job, regardless of how many sub-workers run inside it).
   *      `tasksCompleted/tasksFailed` job counters are incremented only by
   *      the parent terminal flush, not by every child, so we keep
   *      `taskCount=1` on the job.
   *   3. The `template` is required (the planner explicitly chose it via
   *      hub_spawn args) — no fallback to `projectConfig.workerPreference`.
   *
   * If the worker pool is full, the child stays in `activeTasks` with
   * status `pending` and will be re-tried on the next scheduling tick by
   * `runOnce()`'s pending-task pass — same path as a `submitTask` that
   * couldn't dispatch immediately. A child subscribed to tasks that have
   * not landed waits the same way, see `dependenciesLanded`.
   */
  async submitChildTask(opts: {
    parentTaskId: string;
    parentJobId: string;
    project: string;
    description: string;
    template: string;
    subscribe?: HubSubscribeInput;
  }): Promise<TaskRecord | null> {
    const projectInfo = this.projectRegistry.resolve(opts.project);
    if (!projectInfo) {
      this.warnUnknownProjectOnce(opts.project);
      return null;
    }

    const childTemplate = this.config.workerTemplates[opts.template];
    if (!childTemplate) {
      logger.warn(
        `[ClusterScheduler] submitChildTask: unknown workerTemplate "${opts.template}". ` +
          `Available: ${Object.keys(this.config.workerTemplates).join(', ') || '(none)'}`,
      );
      return null;
    }
    // Phase 3 one-layer rule: a planner-spawned child must run on an
    // executor template. Defense-in-depth alongside the ContextHub.handleSpawn
    // role check — if anyone bypasses the hub and calls submitChildTask
    // directly with a planner template, we still reject here.
    if (childTemplate.role === 'planner') {
      logger.warn(
        `[ClusterScheduler] submitChildTask: planner-role template "${opts.template}" is not allowed for child tasks (one-layer rule)`,
      );
      return null;
    }
    if (childTemplate.enabled === false) {
      logger.warn(
        `[ClusterScheduler] submitChildTask: template "${opts.template}" is disabled (enabled: false) — refusing child spawn`,
      );
      return null;
    }

    const task = this.createTask(opts.parentJobId, opts.project, opts.description, 'planner');
    task.workerTemplate = opts.template;
    task.parentTaskId = opts.parentTaskId;
    this.persistTask(task);
    if (opts.subscribe) {
      this.hub.preSubscribe(task, opts.subscribe);
    }

    await this.tryDispatch(task, projectInfo);
    return task;
  }
}

function parseUsage(raw: unknown): TaskRecord['usage'] {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    return JSON.parse(raw) as TaskRecord['usage'];
  } catch {
    return undefined;
  }
}
