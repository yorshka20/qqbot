/**
 * LockManager — file-level exclusive locks for worker coordination.
 *
 * Lifecycle: hub_claim creates → hub_report(working) renews → hub_report(terminal) releases.
 * TTL-based expiry as fallback.
 */

import type { Database } from 'bun:sqlite';
import { logger } from '@/utils/logger';
import type { EventLog } from './EventLog';
import type { FileLock, LockConflict } from './types';

export class LockManager {
  private locks = new Map<string, FileLock>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private eventLog: EventLog,
    private defaultTTL: number = 600_000, // 10 minutes
  ) {
    this.loadFromDB();
    this.startCleanup();
  }

  private loadFromDB(): void {
    try {
      const rows = this.db.query('SELECT * FROM cluster_locks').all() as Array<Record<string, unknown>>;
      const now = Date.now();
      for (const row of rows) {
        const lock: FileLock = {
          filePath: row.filePath as string,
          workerId: row.workerId as string,
          taskId: row.taskId as string | undefined,
          claimedAt: row.claimedAt as number,
          lastRenewed: row.lastRenewed as number,
          ttl: row.ttl as number,
        };
        // Skip expired locks
        if (now - lock.lastRenewed < lock.ttl) {
          this.locks.set(lock.filePath, lock);
        } else {
          this.db.query('DELETE FROM cluster_locks WHERE filePath = ?').run(lock.filePath);
        }
      }
      if (this.locks.size > 0) {
        logger.info(`[LockManager] Loaded ${this.locks.size} active locks from DB`);
      }
    } catch {
      // Table may not exist yet
    }
  }

  /**
   * Try to acquire locks for a set of files.
   * Returns conflicts if any files are already locked by other workers.
   */
  tryAcquire(
    files: string[],
    workerId: string,
    taskId?: string,
  ): { granted: boolean; conflicts: LockConflict[] } {
    const conflicts: LockConflict[] = [];
    const now = Date.now();

    for (const file of files) {
      const existing = this.locks.get(file);
      if (existing && existing.workerId !== workerId) {
        // Check if expired
        if (now - existing.lastRenewed >= existing.ttl) {
          this.releaseLock(file, 'expired');
        } else {
          conflicts.push({
            file,
            heldBy: existing.workerId,
            since: existing.claimedAt,
            estimatedRelease: existing.lastRenewed + existing.ttl,
          });
        }
      }
    }

    if (conflicts.length > 0) {
      return { granted: false, conflicts };
    }

    // Acquire all locks
    for (const file of files) {
      const lock: FileLock = {
        filePath: file,
        workerId,
        taskId,
        claimedAt: now,
        lastRenewed: now,
        ttl: this.defaultTTL,
      };
      this.locks.set(file, lock);
      this.persistLock(lock);

      this.eventLog.append('lock_acquired', workerId, { file }, { taskId });
    }

    return { granted: true, conflicts: [] };
  }

  /**
   * Renew all locks held by a worker (called on every hub_report/hub_sync).
   */
  renewAll(workerId: string): void {
    const now = Date.now();
    for (const lock of this.locks.values()) {
      if (lock.workerId === workerId) {
        lock.lastRenewed = now;
        this.persistLock(lock);
      }
    }
  }

  /**
   * Release all locks held by a worker.
   */
  releaseAll(workerId: string): void {
    const toRelease: string[] = [];
    for (const [file, lock] of this.locks) {
      if (lock.workerId === workerId) {
        toRelease.push(file);
      }
    }
    for (const file of toRelease) {
      this.releaseLock(file, workerId);
    }
    if (toRelease.length > 0) {
      logger.info(`[LockManager] Released ${toRelease.length} locks for worker ${workerId}`);
    }
  }

  /**
   * Get all active locks.
   */
  getActiveLocks(): FileLock[] {
    return Array.from(this.locks.values());
  }

  /**
   * Get locks held by a specific worker.
   */
  getWorkerLocks(workerId: string): FileLock[] {
    return Array.from(this.locks.values()).filter((l) => l.workerId === workerId);
  }

  /**
   * Stop the cleanup timer.
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private releaseLock(file: string, releasedBy: string): void {
    const lock = this.locks.get(file);
    if (!lock) return;

    this.locks.delete(file);
    this.db.query('DELETE FROM cluster_locks WHERE filePath = ?').run(file);

    this.eventLog.append('lock_released', lock.workerId, {
      file,
      releasedBy,
      heldForMs: Date.now() - lock.claimedAt,
    });
  }

  private persistLock(lock: FileLock): void {
    try {
      this.db
        .query(
          `INSERT OR REPLACE INTO cluster_locks (filePath, workerId, taskId, claimedAt, lastRenewed, ttl)
         VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(lock.filePath, lock.workerId, lock.taskId ?? null, lock.claimedAt, lock.lastRenewed, lock.ttl);
    } catch (err) {
      logger.error('[LockManager] Failed to persist lock:', err);
    }
  }

  private startCleanup(): void {
    // Check for expired locks every 60 seconds
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [file, lock] of this.locks) {
        if (now - lock.lastRenewed >= lock.ttl) {
          logger.warn(`[LockManager] Lock expired for ${file} (worker: ${lock.workerId})`);
          this.releaseLock(file, 'expired');
        }
      }
    }, 60_000);
  }
}
