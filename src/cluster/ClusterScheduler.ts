/**
 * ClusterScheduler — core scheduling loop for the Agent Cluster.
 *
 * Continuously polls TaskSources, assigns tasks to workers via WorkerPool.
 */

import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { logger } from '@/utils/logger';
import type { ContextHub } from './ContextHub';
import type { ClusterConfig, ClusterProjectConfig } from './config';
import type { TaskSource } from './sources/TaskSource';
import type { JobRecord, TaskCandidate, TaskRecord } from './types';
import type { WorkerPool } from './WorkerPool';

export class ClusterScheduler {
  private running = false;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private taskSources = new Map<string, TaskSource[]>(); // project → sources
  private activeTasks = new Map<string, TaskRecord>(); // taskId → record
  private jobs = new Map<string, JobRecord>(); // jobId → record

  constructor(
    private config: ClusterConfig,
    private hub: ContextHub,
    private workerPool: WorkerPool,
    private db: Database,
    private projectResolver: (alias: string) => { alias: string; path: string; type: string } | undefined,
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
    logger.info(`[ClusterScheduler] Started (interval: ${this.config.schedulingInterval}ms)`);
    this.scheduleNextRun();
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
   * Manually submit a task to the queue.
   */
  async submitTask(project: string, description: string): Promise<TaskRecord | null> {
    const projectInfo = this.projectResolver(project);
    if (!projectInfo) {
      logger.warn(`[ClusterScheduler] Unknown project: ${project}`);
      return null;
    }

    // Create a one-off job
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
    return task;
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
   * Get tasks for a specific job.
   */
  getJobTasks(jobId: string): TaskRecord[] {
    return Array.from(this.activeTasks.values()).filter((t) => t.jobId === jobId);
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

    // 4. Assign to workers
    for (const candidate of sorted) {
      if (!this.workerPool.canSpawnMore()) break;

      const projectConfig = this.config.projects[candidate.project];
      const templateName = projectConfig?.workerPreference || Object.keys(this.config.workerTemplates)[0];
      if (!templateName) continue;

      const projectInfo = this.projectResolver(candidate.project);
      if (!projectInfo) continue;

      // Create job + task
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

      // Spawn worker
      const worker = await this.workerPool.spawnWorker(templateName, candidate.project, projectInfo.path, task);
      if (worker) {
        task.status = 'running';
        task.workerId = worker.id;
        task.workerTemplate = templateName;
        task.startedAt = new Date().toISOString();
        this.persistTask(task);
      }
    }

    // 5. Health check
    const stuckWorkers = this.workerPool.healthCheck();
    for (const workerId of stuckWorkers) {
      logger.warn(`[ClusterScheduler] Killing stuck worker: ${workerId}`);
      await this.workerPool.killWorker(workerId);
    }
  }

  private async collectTasks(): Promise<TaskCandidate[]> {
    const all: TaskCandidate[] = [];

    for (const [project, sources] of this.taskSources) {
      const projectInfo = this.projectResolver(project);
      if (!projectInfo) continue;

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
          createdAt, claimedAt, startedAt, completedAt, output, error, filesModified, diffSummary, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        );
    } catch (err) {
      logger.error('[ClusterScheduler] Failed to persist task:', err);
    }
  }
}
