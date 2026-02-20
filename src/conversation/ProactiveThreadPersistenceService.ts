// Proactive Thread Persistence Service - persist ended threads to DB

import type { DatabaseManager } from '@/database/DatabaseManager';
import type { ProactiveThreadRecord } from '@/database/models/types';
import { logger } from '@/utils/logger';
import type { ProactiveThread } from './ThreadService';

/**
 * Persists ended proactive threads to the database.
 * Summary can be context text or LLM summary (method TBD); default is formatted messages.
 */
export interface ProactiveThreadPersistenceService {
  /**
   * Save an ended thread to the database. Call before removing from ThreadService.
   * @param thread - The thread to persist (from ThreadService.getThread)
   * @param summary - Optional summary; if omitted, thread messages are formatted as text
   */
  saveEndedThread(thread: ProactiveThread, summary?: string): Promise<void>;
}

/**
 * Default implementation: writes to proactive_threads table via DatabaseManager.
 */
export class DefaultProactiveThreadPersistenceService implements ProactiveThreadPersistenceService {
  constructor(private databaseManager: DatabaseManager) { }

  async saveEndedThread(thread: ProactiveThread, summary?: string): Promise<void> {
    const adapter = this.databaseManager.getAdapter();
    const accessor = adapter.getModel('proactiveThreads');

    const summaryText =
      summary ??
      thread.messages
        .map((m) => {
          if (m.isSummary) {
            return `[Summary of earlier messages]: ${m.content}`;
          }
          const who = m.isBotReply ? 'Assistant' : `User<${m.userId}>`;
          return `${m.createdAt.toISOString()} ${who}: ${m.content}`;
        })
        .join('\n');

    const record: Omit<ProactiveThreadRecord, 'id' | 'createdAt' | 'updatedAt'> = {
      groupId: thread.groupId,
      threadId: thread.threadId,
      preferenceKey: thread.preferenceKey,
      summary: summaryText,
      endedAt: new Date(),
    };

    try {
      await accessor.create(record);
      logger.info(
        `[ProactiveThreadPersistenceService] Saved ended thread | threadId=${thread.threadId} | groupId=${thread.groupId}`,
      );
    } catch (err) {
      logger.error(
        `[ProactiveThreadPersistenceService] Failed to save ended thread | threadId=${thread.threadId}:`,
        err,
      );
      throw err;
    }
  }
}
