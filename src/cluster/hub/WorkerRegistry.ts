/**
 * WorkerRegistry — tracks all registered workers and their status.
 *
 * Workers auto-register on first hub tool call.
 */

import { logger } from '@/utils/logger';
import type { WorkerRegistration } from '../types';

export class WorkerRegistry {
  private workers = new Map<string, WorkerRegistration>();

  /**
   * Register or update a worker.
   */
  register(
    workerId: string,
    opts: {
      role?: WorkerRegistration['role'];
      project?: string;
      templateName?: string;
    },
  ): WorkerRegistration {
    const existing = this.workers.get(workerId);
    if (existing) {
      existing.lastSeen = Date.now();
      if (opts.role) existing.role = opts.role;
      if (opts.project) existing.project = opts.project;
      if (opts.templateName) existing.templateName = opts.templateName;
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
    }
  }

  /**
   * Touch a worker (update lastSeen).
   */
  touch(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.lastSeen = Date.now();
    }
  }

  /**
   * Set current task for a worker.
   */
  setTask(workerId: string, taskId: string | undefined): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.currentTaskId = taskId;
      worker.status = taskId ? 'active' : 'idle';
    }
  }

  /**
   * Increment stats.
   */
  incrementStat(workerId: string, stat: 'tasksCompleted' | 'tasksFailed' | 'totalReports'): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.stats[stat]++;
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
      }
    }
  }
}
