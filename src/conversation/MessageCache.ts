// Message Cache - simple singleton for in-memory message caching

import { ProtocolName } from '@/core/config/protocol';
import type { NormalizedMessageEvent } from '@/events/types';
import { logger } from '@/utils/logger';

/**
 * Simple in-memory message cache
 * Singleton pattern for shared cache across the application
 */
class MessageCache {
  private cache = new Map<string, NormalizedMessageEvent>();
  private maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  /**
   * Store message in cache
   * Key format: `${protocol}:${messageId}` or `${protocol}:${groupId}:${messageSeq}` for Milky protocol
   */
  set(protocol: ProtocolName, messageId: number, message: NormalizedMessageEvent, groupId?: number): void {
    const key = `${protocol}:${messageId}`;

    // If cache is full, remove oldest entry (FIFO)
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, message);
  }

  /**
   * Store message in cache by messageSeq (for Milky protocol, requires groupId)
   * Key format: `${protocol}:${groupId}:${messageSeq}`
   */
  setBySeq(protocol: ProtocolName, groupId: number, messageSeq: number, message: NormalizedMessageEvent): void {
    const key = `${protocol}:${groupId}:${messageSeq}`;

    // If cache is full, remove oldest entry (FIFO)
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, message);
  }

  /**
   * Get message from cache
   */
  get(protocol: ProtocolName, messageId: number): NormalizedMessageEvent | undefined {
    const key = `${protocol}:${messageId}`;
    return this.cache.get(key);
  }

  /**
   * Get message from cache by messageSeq (for Milky protocol, requires groupId)
   */
  getBySeq(protocol: ProtocolName, groupId: number, messageSeq: number): NormalizedMessageEvent | undefined {
    const key = `${protocol}:${groupId}:${messageSeq}`;
    return this.cache.get(key);
  }

  /**
   * Clear cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache size
   */
  size(): number {
    return this.cache.size;
  }
}

// Singleton instance
let messageCacheInstance: MessageCache | null = null;

/**
 * Get or create message cache singleton
 */
export function getMessageCache(): MessageCache {
  if (!messageCacheInstance) {
    messageCacheInstance = new MessageCache(500);
  }
  return messageCacheInstance;
}

/**
 * Cache a message
 * For Milky protocol, also cache by messageSeq with groupId if available
 */
export function cacheMessage(message: NormalizedMessageEvent): void {
  if (!message.protocol) {
    return;
  }

  // Cache by messageId if available
  if (message.messageId) {
    getMessageCache().set(message.protocol, message.messageId, message, message.groupId);
    logger.debug(`[MessageCache] Cached message | protocol=${message.protocol} | messageId=${message.messageId}`);
  }

  // For Milky protocol, also cache by messageSeq with groupId (required for uniqueness)
  if (message.protocol === 'milky' && message.groupId) {
    const milkyMessage = message as NormalizedMessageEvent & { messageSeq?: number };
    if (milkyMessage.messageSeq !== undefined && typeof milkyMessage.messageSeq === 'number') {
      getMessageCache().setBySeq(message.protocol, message.groupId, milkyMessage.messageSeq, message);
      logger.debug(
        `[MessageCache] Cached message by messageSeq | protocol=${message.protocol} | groupId=${message.groupId} | messageSeq=${milkyMessage.messageSeq}`,
      );
    }
  }
}

/**
 * Get message from cache
 */
export function getCachedMessage(protocol: ProtocolName, messageId: number): NormalizedMessageEvent | undefined {
  return getMessageCache().get(protocol, messageId);
}

/**
 * Get message from cache by messageSeq (for Milky protocol, requires groupId)
 */
export function getCachedMessageBySeq(
  protocol: ProtocolName,
  groupId: number,
  messageSeq: number,
): NormalizedMessageEvent | undefined {
  if (protocol !== 'milky') {
    return undefined;
  }
  return getMessageCache().getBySeq(protocol, groupId, messageSeq);
}
