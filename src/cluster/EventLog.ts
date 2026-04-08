/**
 * EventLog — ordered event stream for the Agent Cluster.
 *
 * All worker reports, claims, messages produce events here.
 * Each worker maintains a cursor; hub_sync returns events after cursor.
 */

import type { Database } from 'bun:sqlite';
import { logger } from '@/utils/logger';
import type { ClusterEventType, EventEntry } from './types';

export class EventLog {
  /** In-memory ring buffer of recent events */
  private events: EventEntry[] = [];
  /** Next sequence number */
  private nextSeq = 1;
  /** Compacted summary for workers whose cursor fell behind */
  private compactedSummary: string | null = null;
  /** Lowest seq still in memory */
  private minSeqInMemory = 1;

  constructor(
    private db: Database,
    private maxSize: number = 1000,
  ) {
    this.loadLastSeq();
  }

  private loadLastSeq(): void {
    try {
      const row = this.db.query('SELECT MAX(seq) as maxSeq FROM cluster_events').get() as {
        maxSeq: number | null;
      } | null;
      if (row?.maxSeq) {
        this.nextSeq = row.maxSeq + 1;
        this.minSeqInMemory = this.nextSeq; // we start fresh in memory
      }
    } catch {
      // Table may not exist yet during first boot
    }
  }

  /**
   * Append an event to the log.
   */
  append(
    type: ClusterEventType,
    sourceWorkerId: string,
    data: Record<string, unknown>,
    opts?: { targetWorkerId?: string; jobId?: string; taskId?: string },
  ): EventEntry {
    const entry: EventEntry = {
      seq: this.nextSeq++,
      timestamp: Date.now(),
      type,
      sourceWorkerId,
      targetWorkerId: opts?.targetWorkerId,
      data,
      jobId: opts?.jobId,
      taskId: opts?.taskId,
    };

    // Persist to SQLite
    try {
      this.db
        .query(
          `INSERT INTO cluster_events (seq, timestamp, type, sourceWorkerId, targetWorkerId, data, jobId, taskId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.seq,
          entry.timestamp,
          entry.type,
          entry.sourceWorkerId,
          entry.targetWorkerId ?? null,
          JSON.stringify(entry.data),
          entry.jobId ?? null,
          entry.taskId ?? null,
        );
    } catch (err) {
      logger.error('[EventLog] Failed to persist event:', err);
    }

    // Keep in memory
    this.events.push(entry);
    if (this.events.length > this.maxSize) {
      this.compact();
    }

    return entry;
  }

  /**
   * Get events after a given cursor (sequence number), optionally filtering out
   * events produced by the requesting worker.
   */
  getAfter(cursor: number, excludeWorkerId?: string): { events: EventEntry[]; compactedSummary?: string } {
    let compactedSummary: string | undefined;

    // If cursor is behind what's in memory, return compacted summary + all in-memory events
    if (cursor < this.minSeqInMemory) {
      compactedSummary = this.compactedSummary || 'Some earlier events were compacted.';
    }

    let result = this.events.filter((e) => e.seq > cursor);
    if (excludeWorkerId) {
      result = result.filter((e) => e.sourceWorkerId !== excludeWorkerId);
    }

    return { events: result, compactedSummary };
  }

  /**
   * Get events filtered by various criteria (for API queries).
   */
  query(opts: {
    type?: ClusterEventType;
    workerId?: string;
    taskId?: string;
    jobId?: string;
    limit?: number;
    offset?: number;
  }): EventEntry[] {
    const conditions: string[] = [];
    const params: (string | number | null)[] = [];

    if (opts.type) {
      conditions.push('type = ?');
      params.push(opts.type);
    }
    if (opts.workerId) {
      conditions.push('(sourceWorkerId = ? OR targetWorkerId = ?)');
      params.push(opts.workerId, opts.workerId);
    }
    if (opts.taskId) {
      conditions.push('taskId = ?');
      params.push(opts.taskId);
    }
    if (opts.jobId) {
      conditions.push('jobId = ?');
      params.push(opts.jobId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit || 100;
    const offset = opts.offset || 0;

    const rows = this.db
      .query(`SELECT * FROM cluster_events ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      seq: row.seq as number,
      timestamp: row.timestamp as number,
      type: row.type as ClusterEventType,
      sourceWorkerId: row.sourceWorkerId as string,
      targetWorkerId: row.targetWorkerId as string | undefined,
      data: JSON.parse(row.data as string),
      jobId: row.jobId as string | undefined,
      taskId: row.taskId as string | undefined,
    }));
  }

  /**
   * Compact old events — keep only recent maxSize entries in memory.
   */
  private compact(): void {
    const excess = this.events.length - this.maxSize;
    if (excess <= 0) return;

    const removed = this.events.splice(0, excess);
    this.minSeqInMemory = this.events.length > 0 ? this.events[0].seq : this.nextSeq;

    // Build a textual summary of compacted events
    const typeCounts = new Map<string, number>();
    for (const e of removed) {
      typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
    }
    const parts = Array.from(typeCounts.entries()).map(([type, count]) => `${type}:${count}`);
    this.compactedSummary = `Compacted ${removed.length} events (${parts.join(', ')})`;
    logger.debug(`[EventLog] ${this.compactedSummary}`);
  }

  /**
   * Get current sequence number (for initial cursor assignment).
   */
  getCurrentSeq(): number {
    return this.nextSeq - 1;
  }
}
