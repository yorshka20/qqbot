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
   * Store message in cache by messageSeq (for Milky protocol)
   * For group messages: uses groupId, key format: `${protocol}:g:${groupId}:${messageSeq}`
   * For private messages: uses userId, key format: `${protocol}:u:${userId}:${messageSeq}`
   */
  setBySeq(
    protocol: ProtocolName,
    groupIdOrUserId: number,
    messageSeq: number,
    message: NormalizedMessageEvent,
    isGroup: boolean,
  ): void {
    const prefix = isGroup ? 'g' : 'u';
    const key = `${protocol}:${prefix}:${groupIdOrUserId}:${messageSeq}`;

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
   * Get message from cache by messageSeq (for Milky protocol)
   * For group messages: uses groupId
   * For private messages: uses userId
   */
  getBySeq(
    protocol: ProtocolName,
    groupIdOrUserId: number,
    messageSeq: number,
    isGroup: boolean,
  ): NormalizedMessageEvent | undefined {
    const prefix = isGroup ? 'g' : 'u';
    const key = `${protocol}:${prefix}:${groupIdOrUserId}:${messageSeq}`;
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

  // For Milky protocol, cache by messageSeq
  // Group messages: use groupId (messageSeq unique within group)
  // Private messages: messageSeq is globally unique, but we still cache for quick lookup
  // Use a special key format for private: protocol:private:messageSeq
  if (message.protocol === 'milky') {
    const milkyMessage = message as NormalizedMessageEvent & { messageSeq?: number };
    if (milkyMessage.messageSeq !== undefined && typeof milkyMessage.messageSeq === 'number') {
      if (message.groupId) {
        // Group message: use groupId (messageSeq unique within group)
        getMessageCache().setBySeq(message.protocol, message.groupId, milkyMessage.messageSeq, message, true);
        logger.debug(
          `[MessageCache] Cached group message by messageSeq | protocol=${message.protocol} | groupId=${message.groupId} | messageSeq=${milkyMessage.messageSeq}`,
        );
      } else if (message.messageType === 'private') {
        // Private message: messageSeq is globally unique, use 0 as placeholder for userId
        // Key format: milky:u:0:messageSeq (0 indicates global uniqueness)
        getMessageCache().setBySeq(message.protocol, 0, milkyMessage.messageSeq, message, false);
        logger.debug(
          `[MessageCache] Cached private message by messageSeq | protocol=${message.protocol} | messageSeq=${milkyMessage.messageSeq}`,
        );
      }
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
 * Get message from cache by messageSeq (for Milky protocol)
 * For group messages: uses groupId
 * For private messages: uses userId
 */
export function getCachedMessageBySeq(
  protocol: ProtocolName,
  groupIdOrUserId: number,
  messageSeq: number,
  isGroup: boolean,
): NormalizedMessageEvent | undefined {
  if (protocol !== 'milky') {
    return undefined;
  }
  return getMessageCache().getBySeq(protocol, groupIdOrUserId, messageSeq, isGroup);
}
