/**
 * ClusterScheduler — core scheduling loop for the Agent Cluster.
 *
 * Continuously polls TaskSources, assigns tasks to workers via WorkerPool.
 */

import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { ProjectRegistry } from '@/services/claudeCode/ProjectRegistry';
import { logger } from '@/utils/logger';
import type { ClusterConfig } from './config';
import type { ContextHub } from './hub/ContextHub';
import type { TaskSource } from './sources/TaskSource';
import type { JobRecord, TaskCandidate, TaskRecord } from './types';
import type { WorkerPool } from './WorkerPool';

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

  constructor(
    private config: ClusterConfig,
    private hub: ContextHub,
    private workerPool: WorkerPool,
    private db: Database,
    private projectRegistry: ProjectRegistry,
  ) {}

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
   * `persistTask()` on every call so the second caller can refresh DB rows
   * with the fuller output captured after process exit.
   *
   * Idempotency model:
   *   - persistTask: runs every call (SQLite UPSERT, latest-write-wins)
   *   - job counter update + activeTasks.delete: runs exactly once
   *
   * See docs/local/agent-cluster.md Issue D (original Phase 1 bug) and
   * §2.3 (hub_report wiring) for the full story.
   */
  markTaskCompleted(task: TaskRecord): void {
    // Always persist — allows the post-exit code path to overwrite the
    // row with richer `task.output` even when hub_report fired first.
    this.persistTask(task);

    // Job counter updates must happen exactly once per task. If the task
    // has already been removed from activeTasks, a prior call already
    // incremented the counters; skip them this time.
    if (!this.activeTasks.has(task.id)) {
      return;
    }

    const job = this.jobs.get(task.jobId);
    if (job) {
      if (task.status === 'completed') {
        job.tasksCompleted += 1;
      } else if (task.status === 'failed') {
        job.tasksFailed += 1;
      }
      const totalDone = job.tasksCompleted + job.tasksFailed;
      if (totalDone >= job.taskCount) {
        job.status = job.tasksFailed > 0 && job.tasksCompleted === 0 ? 'failed' : 'completed';
        job.completedAt = new Date().toISOString();
      }
      this.persistJob(job);
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
      child.status = 'failed';
      child.error = `Cancelled: parent task ${parentTaskId} terminated`;
      child.completedAt = new Date().toISOString();
      this.persistTask(child);
      this.activeTasks.delete(child.id);

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
   * Persist partial stdout while a worker is still running so the WebUI can
   * show live task output instead of an empty field until the process exits.
   */
  flushRunningTaskOutput(task: TaskRecord): void {
    const live = this.activeTasks.get(task.id);
    if (!live || live !== task) {
      return;
    }
    if (live.status !== 'running') {
      return;
    }
    this.persistTask(live);
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
  async submitTask(
    project: string,
    description: string,
    options?: { workerTemplate?: string; requirePlannerRole?: boolean },
  ): Promise<TaskRecord | null> {
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

    // Phase 3: ticket dispatched with usePlanner=true sets requirePlannerRole.
    // We must select a planner-role template; if the explicit override is an
    // executor template, fail loudly rather than silently downgrade the
    // ticket to a single-worker run (the user explicitly asked for planner
    // semantics).
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
      tasksCompleted: 0,
      tasksFailed: 0,
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
      if (tpl?.role === 'planner') return explicit;
      logger.warn(
        `[ClusterScheduler] cluster.defaultPlannerTemplate "${explicit}" is missing or not a planner-role template; scanning workerTemplates`,
      );
    }
    for (const [name, tpl] of Object.entries(this.config.workerTemplates)) {
      if (tpl.role === 'planner') return name;
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
  private async tryDispatch(
    task: TaskRecord,
    projectInfo: { alias: string; path: string; type: string },
  ): Promise<boolean> {
    if (!this.workerPool.canSpawnMore()) return false;

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

    const worker = await this.workerPool.spawnWorker(templateName, task.project, projectInfo.path, task);
    if (worker) {
      task.status = 'running';
      task.workerId = worker.id;
      task.workerTemplate = templateName;
      task.startedAt = new Date().toISOString();
      this.persistTask(task);
      return true;
    }
    return false;
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
    for (const task of this.activeTasks.values()) {
      if (task.status !== 'pending') continue;
      if (!this.workerPool.canSpawnMore()) break;
      const projectInfo = this.projectRegistry.resolve(task.project);
      if (!projectInfo) continue;
      await this.tryDispatch(task, projectInfo);
    }

    // 6. Health check
    const stuckWorkers = this.workerPool.healthCheck();
    for (const workerId of stuckWorkers) {
      logger.warn(`[ClusterScheduler] Killing stuck worker: ${workerId}`);
      await this.workerPool.killWorker(workerId);
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
      `[ClusterScheduler] Unknown project "${project}" — not registered in ClaudeCodeService.projectRegistry. ` +
        `Tasks for this project will be skipped. Check cluster.jsonc projects keys against your project registry.`,
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
          `These cluster projects are NOT registered in ClaudeCodeService.projectRegistry — ` +
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
         (id, project, description, status, createdAt, startedAt, completedAt, taskCount, tasksCompleted, tasksFailed, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        );
    } catch (err) {
      logger.error('[ClusterScheduler] Failed to persist job:', err);
    }
  }

  private persistTask(task: TaskRecord): void {
    try {
      this.db
        .query(
          `INSERT OR REPLACE INTO cluster_tasks
         (id, jobId, project, description, status, workerId, workerTemplate, source,
          createdAt, claimedAt, startedAt, completedAt, output, error, filesModified, diffSummary, metadata, parentTaskId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          task.output ?? null,
          task.error ?? null,
          task.filesModified ?? null,
          task.diffSummary ?? null,
          task.metadata ?? null,
          task.parentTaskId ?? null,
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
   * couldn't dispatch immediately.
   */
  async submitChildTask(opts: {
    parentTaskId: string;
    parentJobId: string;
    project: string;
    description: string;
    template: string;
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

    const task = this.createTask(opts.parentJobId, opts.project, opts.description, 'planner');
    task.workerTemplate = opts.template;
    task.parentTaskId = opts.parentTaskId;
    this.persistTask(task);

    await this.tryDispatch(task, projectInfo);
    return task;
  }
}
