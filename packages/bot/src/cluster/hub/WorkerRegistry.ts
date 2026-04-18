/**
 * WorkerRegistry — tracks all registered workers and their status.
 *
 * Workers auto-register on first hub tool call.
 * Mutations are persisted to `cluster_workers` (bun:sqlite synchronous API).
 * `touch()` is the sole exception — it fires on every hub tool call and is
 * memory-only to avoid a DB write on every worker heartbeat.
 */

import type { Database } from 'bun:sqlite';
import { logger } from '@/utils/logger';
import type { WorkerRegistration } from '../types';

export class WorkerRegistry {
  private workers = new Map<string, WorkerRegistration>();
  /** jobId per workerId — stored separately to avoid adding a field to WorkerRegistration. */
  private workerJobIds = new Map<string, string>();

  constructor(private db: Database) {}

  /**
   * Register or update a worker.
   */
  register(
    workerId: string,
    opts: {
      role?: WorkerRegistration['role'];
      project?: string;
      templateName?: string;
      jobId?: string;
    },
  ): WorkerRegistration {
    const existing = this.workers.get(workerId);
    if (existing) {
      existing.lastSeen = Date.now();
      if (opts.role) existing.role = opts.role;
      if (opts.project) existing.project = opts.project;
      if (opts.templateName) existing.templateName = opts.templateName;
      this.persist(workerId);
      return existing;
    }

    const registration: WorkerRegistration = {
      workerId,
      role: opts.role || 'coder',
      project: opts.project || '',
      templateName: opts.templateName || '',
      status: 'active',
      lastSeen: Date.now(),
      syncCursor: 0,
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalReports: 0,
        registeredAt: Date.now(),
      },
    };

    this.workers.set(workerId, registration);
    if (opts.jobId) {
      this.workerJobIds.set(workerId, opts.jobId);
    }
    this.persist(workerId);
    logger.info(`[WorkerRegistry] Worker registered: ${workerId} (role: ${registration.role})`);
    return registration;
  }

  /**
   * Get a worker registration.
   */
  get(workerId: string): WorkerRegistration | undefined {
    return this.workers.get(workerId);
  }

  /**
   * Mark a worker as exited and remove it from active tracking.
   */
  markExited(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.status = 'exited';
      worker.exitedAt = Date.now();
      this.persist(workerId);
      logger.info(`[WorkerRegistry] Worker exited: ${workerId}`);
    }
  }

  /**
   * Update the sync cursor for a worker.
   */
  updateCursor(workerId: string, cursor: number): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.syncCursor = cursor;
      worker.lastSeen = Date.now();
      this.persist(workerId);
    }
  }

  /**
   * Touch a worker (update lastSeen). Memory-only — not persisted.
   */
  touch(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.lastSeen = Date.now();
    }
  }

  /**
   * Store the latest hub_report payload for WebUI and debugging.
   */
  recordHubReport(
    workerId: string,
    payload: {
      summary: string;
      nextSteps?: string;
      status: 'working' | 'completed' | 'failed' | 'blocked';
    },
  ): void {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return;
    }
    const now = Date.now();
    worker.lastSeen = now;
    worker.lastHubReportAt = now;
    worker.lastReportSummary = payload.summary;
    worker.lastReportNextSteps = payload.nextSteps;
    worker.lastReportStatus = payload.status;
    this.persist(workerId);
  }

  /**
   * Set current task for a worker.
   */
  setTask(workerId: string, taskId: string | undefined): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      if (taskId) {
        worker.currentTaskId = taskId;
        worker.lastBoundTaskId = taskId;
        worker.status = 'active';
      } else {
        worker.currentTaskId = undefined;
        worker.status = 'idle';
      }
      this.persist(workerId);
    }
  }

  /**
   * Increment stats.
   */
  incrementStat(workerId: string, stat: 'tasksCompleted' | 'tasksFailed' | 'totalReports'): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.stats[stat]++;
      this.persist(workerId);
    }
  }

  /**
   * Get all active workers.
   */
  getActive(): WorkerRegistration[] {
    return Array.from(this.workers.values()).filter((w) => w.status !== 'exited');
  }

  /**
   * Get all workers.
   */
  getAll(): WorkerRegistration[] {
    return Array.from(this.workers.values());
  }

  /**
   * Get count of active workers.
   */
  getActiveCount(): number {
    return this.getActive().length;
  }

  /**
   * Clean up exited workers older than given age.
   */
  cleanup(maxAgeMs: number = 3_600_000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, worker] of this.workers) {
      if (worker.status === 'exited' && worker.lastSeen < cutoff) {
        this.workers.delete(id);
        this.workerJobIds.delete(id);
      }
    }
  }

  /**
   * Get workers for a specific job directly from DB.
   */
  getWorkersByJobId(jobId: string): WorkerRegistration[] {
    try {
      const rows = this.db
        .query('SELECT * FROM cluster_workers WHERE jobId = ? ORDER BY registeredAt ASC')
        .all(jobId) as any[];
      return rows.map((row) => this.rowToRegistration(row));
    } catch (err) {
      logger.error('[WorkerRegistry] getWorkersByJobId failed:', err);
      return [];
    }
  }

  /**
   * Paginated worker history from DB.
   */
  getWorkersFromDb(opts: { limit: number; offset: number; jobId?: string; project?: string }): {
    items: any[];
    total: number;
    hasMore: boolean;
  } {
    try {
      const conditions: string[] = [];
      const params: any[] = [];
      if (opts.jobId) {
        conditions.push('jobId = ?');
        params.push(opts.jobId);
      }
      if (opts.project) {
        conditions.push('project = ?');
        params.push(opts.project);
      }
      const where = conditions.length > 0 ? conditions.join(' AND ') : '1=1';

      const countRow = this.db
        .query(`SELECT COUNT(*) as cnt FROM cluster_workers WHERE ${where}`)
        .get(...params) as any;
      const total = countRow?.cnt ?? 0;

      const rows = this.db
        .query(`SELECT * FROM cluster_workers WHERE ${where} ORDER BY registeredAt DESC LIMIT ? OFFSET ?`)
        .all(...params, opts.limit, opts.offset) as any[];

      const items = rows.map((row) => ({ ...this.rowToRegistration(row), jobId: row.jobId }));
      return { items, total, hasMore: opts.offset + rows.length < total };
    } catch (err) {
      logger.error('[WorkerRegistry] getWorkersFromDb failed:', err);
      return { items: [], total: 0, hasMore: false };
    }
  }

  /**
   * Hydrate in-memory workers map from DB on startup.
   * Skips if already populated (prevents double-hydrate).
   */
  hydrateFromDb(maxAgeMs = 3 * 24 * 3600_000): void {
    if (this.workers.size > 0) return;
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    try {
      const rows = this.db
        .query('SELECT * FROM cluster_workers WHERE registeredAt >= ? ORDER BY registeredAt ASC')
        .all(cutoff) as any[];
      for (const row of rows) {
        const reg = this.rowToRegistration(row);
        this.workers.set(row.workerId, reg);
        if (row.jobId) this.workerJobIds.set(row.workerId, row.jobId);
      }
      if (rows.length > 0) {
        logger.info(`[WorkerRegistry] Hydrated ${rows.length} worker(s) from DB (window: ${maxAgeMs / 86400000}d)`);
      }
    } catch (err) {
      logger.error('[WorkerRegistry] Failed to hydrate from DB:', err);
    }
  }

  // ── Private ──

  private persist(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    const jobId = this.workerJobIds.get(workerId) ?? '';
    try {
      this.db
        .query(
          `INSERT OR REPLACE INTO cluster_workers
           (workerId, jobId, taskId, role, project, templateName, status, registeredAt, lastSeen, exitedAt,
            syncCursor, lastHubReportAt, lastReportSummary, lastReportNextSteps, lastReportStatus,
            tasksCompleted, tasksFailed, totalReports)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          worker.workerId,
          jobId,
          worker.currentTaskId ?? worker.lastBoundTaskId ?? null,
          worker.role,
          worker.project,
          worker.templateName,
          worker.status,
          new Date(worker.stats.registeredAt).toISOString(),
          new Date(worker.lastSeen).toISOString(),
          worker.exitedAt ? new Date(worker.exitedAt).toISOString() : null,
          worker.syncCursor,
          worker.lastHubReportAt ? new Date(worker.lastHubReportAt).toISOString() : null,
          worker.lastReportSummary ?? null,
          worker.lastReportNextSteps ?? null,
          worker.lastReportStatus ?? null,
          worker.stats.tasksCompleted,
          worker.stats.tasksFailed,
          worker.stats.totalReports,
        );
    } catch (err) {
      logger.error(`[WorkerRegistry] Failed to persist worker ${workerId}:`, err);
    }
  }

  private rowToRegistration(row: any): WorkerRegistration {
    const reg: WorkerRegistration = {
      workerId: row.workerId,
      role: row.role,
      project: row.project,
      templateName: row.templateName,
      status: row.status,
      lastSeen: new Date(row.lastSeen).getTime(),
      syncCursor: row.syncCursor ?? 0,
      exitedAt: row.exitedAt ? new Date(row.exitedAt).getTime() : undefined,
      lastHubReportAt: row.lastHubReportAt ? new Date(row.lastHubReportAt).getTime() : undefined,
      lastReportSummary: row.lastReportSummary ?? undefined,
      lastReportNextSteps: row.lastReportNextSteps ?? undefined,
      lastReportStatus: row.lastReportStatus ?? undefined,
      stats: {
        tasksCompleted: row.tasksCompleted ?? 0,
        tasksFailed: row.tasksFailed ?? 0,
        totalReports: row.totalReports ?? 0,
        registeredAt: new Date(row.registeredAt).getTime(),
      },
    };
    if (row.taskId) {
      reg.lastBoundTaskId = row.taskId;
    }
    return reg;
  }
}
