// Deduplicates events from multiple protocols

import type { NormalizedEvent } from './types';
import { logger } from '@/utils/logger';

interface EventFingerprint {
  messageId?: number;
  userId?: number;
  groupId?: number;
  content: string;
  timestamp: number;
  protocol: string;
}

export type DeduplicationStrategy = 'first-received' | 'priority-protocol' | 'merge';

export interface DeduplicationConfig {
  enabled: boolean;
  strategy: DeduplicationStrategy;
  window: number; // Time window in milliseconds
}

export class EventDeduplicator {
  private seenEvents = new Map<string, EventFingerprint>();
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

    const fingerprint = this.createFingerprint(event);
    const key = this.getFingerprintKey(fingerprint);

    const existing = this.seenEvents.get(key);
    if (existing) {
      // Check if within time window
      const timeDiff = event.timestamp - existing.timestamp;
      if (timeDiff <= this.config.window) {
        logger.debug(`[EventDeduplicator] Duplicate event detected: ${key} (${timeDiff}ms ago)`);
        return false;
      }
    }

    // Store fingerprint
    this.seenEvents.set(key, fingerprint);
    return true;
  }

  private createFingerprint(event: NormalizedEvent): EventFingerprint {
    let content = '';
    let messageId: number | undefined;
    let userId: number | undefined;
    let groupId: number | undefined;

    if (event.type === 'message') {
      messageId = event.messageId;
      userId = event.userId;
      groupId = event.groupId;
      content = event.message || '';
    } else {
      content = JSON.stringify(event);
    }

    return {
      messageId,
      userId,
      groupId,
      content,
      timestamp: event.timestamp,
      protocol: event.protocol,
    };
  }

  private getFingerprintKey(fingerprint: EventFingerprint): string {
    // Create a unique key based on event characteristics
    if (fingerprint.messageId) {
      return `msg_${fingerprint.messageId}`;
    }
    if (fingerprint.userId && fingerprint.groupId) {
      return `group_${fingerprint.groupId}_user_${fingerprint.userId}_${fingerprint.content.substring(0, 50)}`;
    }
    if (fingerprint.userId) {
      return `user_${fingerprint.userId}_${fingerprint.content.substring(0, 50)}`;
    }
    return `event_${fingerprint.protocol}_${fingerprint.content.substring(0, 50)}`;
  }

  private startCleanup(): void {
    // Clean up old fingerprints periodically
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const toDelete: string[] = [];

      for (const [key, fingerprint] of this.seenEvents.entries()) {
        if (now - fingerprint.timestamp > this.config.window * 2) {
          toDelete.push(key);
        }
      }

      toDelete.forEach((key) => this.seenEvents.delete(key));
      if (toDelete.length > 0) {
        logger.debug(`[EventDeduplicator] Cleaned up ${toDelete.length} old fingerprints`);
      }
    }, this.config.window);
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.seenEvents.clear();
  }
}
