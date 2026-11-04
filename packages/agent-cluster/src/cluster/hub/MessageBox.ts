/**
 * MessageBox — per-worker message queues.
 *
 * Sources: hub_message from other workers, planner directives, hub_ask answers.
 * Messages are consumed via hub_sync (merged into updates).
 *
 * A message waits in `cluster_messages` until the worker's next hub_sync, which may come
 * after a scheduler restart (workers are detached), so every write goes through to the DB
 * and unread messages are loaded back on construction.
 */

import type { Database } from 'bun:sqlite';
import { logger, randomUUID } from '@qqbot/shared';
import type { HubUpdate } from '../types';

export interface PendingMessage {
  id: string;
  targetWorkerId: string;
  type: 'directive' | 'answer' | 'message';
  from: string;
  content: string;
  priority: 'info' | 'warning';
  createdAt: number;
  read: boolean;
}

export class MessageBox {
  private messages: PendingMessage[] = [];

  constructor(
    private db: Database,
    /** Called after a message is queued; the hub wakes a worker blocked in hub_wait with it. */
    private onSend?: (targetWorkerId: string) => void,
  ) {
    this.load();
  }

  /**
   * Enqueue a message for a worker.
   */
  send(
    targetWorkerId: string,
    from: string,
    content: string,
    type: 'directive' | 'answer' | 'message' = 'message',
    priority: 'info' | 'warning' = 'info',
  ): string {
    const id = randomUUID();
    const message: PendingMessage = {
      id,
      targetWorkerId,
      type,
      from,
      content,
      priority,
      createdAt: Date.now(),
      read: false,
    };
    this.messages.push(message);
    try {
      this.db
        .query(
          `INSERT INTO cluster_messages (id, targetWorkerId, type, sender, content, priority, createdAt, read)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(id, targetWorkerId, type, from, content, priority, message.createdAt);
    } catch (err) {
      logger.error('[MessageBox] Failed to persist message:', err);
    }
    logger.debug(`[MessageBox] Message ${id} queued for ${targetWorkerId} from ${from}`);
    this.onSend?.(targetWorkerId);
    return id;
  }

  /**
   * Consume unread messages for a worker, converting to HubUpdate format.
   * Marks messages as read.
   */
  consume(workerId: string): HubUpdate[] {
    const updates: HubUpdate[] = [];
    for (const msg of this.messages) {
      if (msg.targetWorkerId === workerId && !msg.read) {
        this.markRead(msg);
        updates.push({
          type: msg.type === 'directive' ? 'directive' : msg.type === 'answer' ? 'answer' : 'message',
          from: msg.from,
          summary: msg.content,
          data: { messageId: msg.id, priority: msg.priority },
        });
      }
    }
    return updates;
  }

  /**
   * Get unread directive messages for a worker (used in hub_report return).
   */
  getUnreadDirectives(workerId: string): string[] {
    const directives: string[] = [];
    for (const msg of this.messages) {
      if (msg.targetWorkerId === workerId && !msg.read && msg.type === 'directive') {
        this.markRead(msg);
        directives.push(msg.content);
      }
    }
    return directives;
  }

  /**
   * Get count of unread messages for a worker.
   */
  getUnreadCount(workerId: string): number {
    return this.messages.filter((m) => m.targetWorkerId === workerId && !m.read).length;
  }

  /**
   * Clean up old read messages (older than 1 hour).
   */
  cleanup(): void {
    const cutoff = Date.now() - 3_600_000;
    this.messages = this.messages.filter((m) => !m.read || m.createdAt > cutoff);
    try {
      this.db.query('DELETE FROM cluster_messages WHERE read = 1 AND createdAt <= ?').run(cutoff);
    } catch (err) {
      logger.error('[MessageBox] Failed to clean up messages:', err);
    }
  }

  private markRead(msg: PendingMessage): void {
    msg.read = true;
    try {
      this.db.query('UPDATE cluster_messages SET read = 1 WHERE id = ?').run(msg.id);
    } catch (err) {
      logger.error('[MessageBox] Failed to mark message read:', err);
    }
  }

  private load(): void {
    try {
      const rows = this.db.query('SELECT * FROM cluster_messages WHERE read = 0 ORDER BY createdAt').all() as Array<
        Record<string, unknown>
      >;
      for (const row of rows) {
        this.messages.push({
          id: row.id as string,
          targetWorkerId: row.targetWorkerId as string,
          type: row.type as PendingMessage['type'],
          from: row.sender as string,
          content: row.content as string,
          priority: row.priority as PendingMessage['priority'],
          createdAt: Number(row.createdAt),
          read: false,
        });
      }
      if (rows.length > 0) {
        logger.info(`[MessageBox] Restored ${rows.length} unread message(s) from DB`);
      }
    } catch (err) {
      logger.error('[MessageBox] Failed to load messages:', err);
    }
  }
}
