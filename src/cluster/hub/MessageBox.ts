/**
 * MessageBox — per-worker message queues.
 *
 * Sources: hub_message from other workers, planner directives, hub_ask answers.
 * Messages are consumed via hub_sync (merged into updates).
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/utils/logger';
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
    this.messages.push({
      id,
      targetWorkerId,
      type,
      from,
      content,
      priority,
      createdAt: Date.now(),
      read: false,
    });
    logger.debug(`[MessageBox] Message ${id} queued for ${targetWorkerId} from ${from}`);
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
        msg.read = true;
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
        msg.read = true;
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
  }
}
