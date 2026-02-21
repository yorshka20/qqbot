// Memory Service - single table for group and user memories, in-memory cache + DB sync

import type { DatabaseManager } from '@/database/DatabaseManager';
import type { Memory } from '@/database/models/types';
import { logger } from '@/utils/logger';

/** User ID used for group-level memory slot (one row per group). */
export const GROUP_MEMORY_USER_ID = '_global_memory_';

/** Default max length for content to avoid exceeding SQLite / prompt limits. */
const DEFAULT_MAX_CONTENT_LENGTH = 100_000;

export interface MemoryServiceOptions {
  /** Max length for memory content (truncate if exceeded). */
  maxContentLength?: number;
}

/**
 * In-memory cache: groupId -> (userId | GROUP_MEMORY_USER_ID) -> content.
 * Loaded on startup; writes go to cache then DB.
 */
export class MemoryService {
  private cache = new Map<string, Map<string, string>>();
  private idByKey = new Map<string, string>(); // "${groupId}:${userId}" -> record id for updates
  private maxContentLength: number;

  constructor(
    private databaseManager: DatabaseManager,
    options: MemoryServiceOptions = {},
  ) {
    this.maxContentLength = options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
  }

  /**
   * Load all memories from DB into cache. Call after DB is ready (e.g. on bot start).
   */
  async loadAll(): Promise<void> {
    this.cache.clear();
    this.idByKey.clear();

    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      logger.warn('[MemoryService] DB not connected, skip loadAll');
      return;
    }

    try {
      const model = adapter.getModel('memories');
      const all = await model.find({});
      const list = all as Memory[];

      for (const row of list) {
        const groupId = row.groupId;
        const userId = row.userId;
        const content = row.content ?? '';

        let groupMap = this.cache.get(groupId);
        if (!groupMap) {
          groupMap = new Map<string, string>();
          this.cache.set(groupId, groupMap);
        }
        groupMap.set(userId, content);
        this.idByKey.set(`${groupId}:${userId}`, row.id);
      }

      const total = list.length;
      logger.info(`[MemoryService] Loaded ${total} memory record(s) into cache`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown');
      logger.error('[MemoryService] loadAll failed:', err);
    }
  }

  /**
   * Get group-level memory text for a group (isGlobalMemory=1, userId=GROUP_MEMORY_USER_ID).
   */
  getGroupMemoryText(groupId: string): string {
    const groupMap = this.cache.get(groupId);
    if (!groupMap) {
      return '';
    }
    return groupMap.get(GROUP_MEMORY_USER_ID) ?? '';
  }

  /**
   * Get user-in-group memory text for (groupId, userId).
   */
  getUserMemoryText(groupId: string, userId: string): string {
    const groupMap = this.cache.get(groupId);
    if (!groupMap) {
      return '';
    }
    return groupMap.get(userId) ?? '';
  }

  /**
   * Get both group and user memory texts for reply injection.
   * Group memory is always returned; user memory only when userId is provided.
   */
  getMemoryTextForReply(
    groupId: string,
    userId?: string,
  ): { groupMemoryText: string; userMemoryText: string } {
    const groupMemoryText = this.getGroupMemoryText(groupId);
    const userMemoryText = userId ? this.getUserMemoryText(groupId, userId) : '';
    return { groupMemoryText, userMemoryText };
  }

  /**
   * Truncate content to max length.
   * todo: use llm to summarize.
   */
  private truncate(content: string): string {
    if (content.length <= this.maxContentLength) {
      return content;
    }
    return content.slice(0, this.maxContentLength);
  }

  /**
   * Upsert one memory record by (groupId, userId). Updates in-memory cache then DB.
   * Use GROUP_MEMORY_USER_ID for group-level memory.
   */
  async upsertMemory(
    groupId: string,
    userId: string,
    isGlobalMemory: boolean,
    content: string,
  ): Promise<void> {
    const trimmed = this.truncate(content.trim());
    if (!trimmed && !content.trim()) {
      return;
    }

    const key = `${groupId}:${userId}`;

    // Update cache first
    let groupMap = this.cache.get(groupId);
    if (!groupMap) {
      groupMap = new Map<string, string>();
      this.cache.set(groupId, groupMap);
    }
    groupMap.set(userId, trimmed);

    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      logger.warn('[MemoryService] DB not connected, cache updated only');
      return;
    }

    try {
      const model = adapter.getModel('memories');
      const existing = await model.findOne({ groupId, userId } as Partial<Memory>);
      const record = existing as Memory | null;

      if (record) {
        await model.update(record.id, { content: trimmed, isGlobalMemory });
      } else {
        await model.create({
          groupId,
          userId,
          isGlobalMemory,
          content: trimmed,
        } as Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>);
        const created = await model.findOne({ groupId, userId } as Partial<Memory>);
        if (created) {
          this.idByKey.set(key, (created as Memory).id);
        }
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown');
      logger.error('[MemoryService] upsertMemory failed:', err);
    }
  }
}
