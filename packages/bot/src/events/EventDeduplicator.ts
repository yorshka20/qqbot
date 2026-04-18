// Deduplicates events from multiple protocols

import { logger } from '@/utils/logger';
import type { NormalizedEvent } from './types';

export type DeduplicationStrategy = 'first-received' | 'priority-protocol' | 'merge';

export interface DeduplicationConfig {
  enabled: boolean;
  strategy: DeduplicationStrategy;
  window: number; // Time window in milliseconds
}

export class EventDeduplicator {
  private seenTimestamps = new Map<string, number>();
  private config: DeduplicationConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: DeduplicationConfig) {
    this.config = config;
    if (config.enabled) {
      this.startCleanup();
    }
  }

  shouldProcess(event: NormalizedEvent): boolean {
    if (!this.config.enabled) {
      return true;
    }

    const key = this.getDeduplicationKey(event);
    if (!key) {
      // No stable identifier — cannot deduplicate, let it through
      return true;
    }

    const existing = this.seenTimestamps.get(key);
    if (existing !== undefined) {
      const timeDiff = event.timestamp - existing;
      if (timeDiff <= this.config.window) {
        logger.debug(`[EventDeduplicator] Duplicate event detected: ${key} (${timeDiff}ms ago)`);
        return false;
      }
    }

    this.seenTimestamps.set(key, event.timestamp);
    return true;
  }

  /**
   * Build a dedup key from stable message identifiers.
   * Cross-protocol dedup: same message delivered via Milky + OneBot11 has the same messageSeq in the same group.
   * Never uses content — two identical-text messages from the same user are distinct events.
   */
  private getDeduplicationKey(event: NormalizedEvent): string | null {
    if (event.type !== 'message') {
      // Non-message events: use the event id (unique per protocol, no cross-protocol dedup needed)
      return null;
    }

    const msg = event as unknown as Record<string, unknown>;

    // Prefer messageSeq (available on Milky, cross-protocol compatible)
    const messageSeq = msg.messageSeq as number | undefined;
    if (typeof messageSeq === 'number') {
      const groupId = msg.groupId;
      if (groupId !== undefined) {
        return `seq_g_${groupId}_${messageSeq}`;
      }
      const userId = msg.userId;
      return `seq_p_${userId}_${messageSeq}`;
    }

    // Fallback: messageId (OneBot11 / Satori)
    const messageId = msg.messageId;
    if (messageId !== undefined && messageId !== null) {
      return `mid_${messageId}`;
    }

    return null;
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const cutoff = Date.now() - this.config.window * 2;
      const toDelete: string[] = [];

      for (const [key, timestamp] of this.seenTimestamps.entries()) {
        if (timestamp < cutoff) {
          toDelete.push(key);
        }
      }

      for (const key of toDelete) {
        this.seenTimestamps.delete(key);
      }
    }, this.config.window);
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.seenTimestamps.clear();
  }
}
