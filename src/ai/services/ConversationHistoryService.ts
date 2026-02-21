// Conversation History Service - provides conversation history building utility

import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { Message } from '@/database/models/types';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';
import type { ThreadService } from '@/conversation/thread';

/**
 * Conversation History Service
 * Provides utility for building conversation history from hook context.
 * When in-memory history is empty (e.g. after restart), loads recent messages from DB.
 */
export class ConversationHistoryService {
  constructor(
    private maxHistoryMessages: number = 10,
    private databaseManager?: DatabaseManager,
  ) {}

  /**
   * Build conversation history for prompt.
   * Uses in-memory context.context.history when available; otherwise loads recent messages from DB.
   * @param context - Hook context
   * @returns Conversation history text (formatted "User: ..." / "Assistant: ..." lines)
   */
  async buildConversationHistory(context: HookContext): Promise<string> {
    // When in proactive thread, use thread context as history
    const proactiveThreadId = context.metadata.get('proactiveThreadId');
    if (proactiveThreadId) {
      const container = getContainer();
      if (container.isRegistered(DITokens.THREAD_SERVICE)) {
        const threadService = container.resolve<ThreadService>(DITokens.THREAD_SERVICE);
        const text = threadService.getContextFormatted(proactiveThreadId);
        if (text) return text;
      }
    }

    const inMemoryHistory = context.context?.history || [];
    if (inMemoryHistory.length > 0) {
      return this.formatHistory(inMemoryHistory);
    }

    // Fallback: load recent messages from DB when in-memory history is empty (e.g. after restart)
    const fromDb = await this.loadRecentHistoryFromDb(context);
    if (fromDb.length > 0) {
      return this.formatHistory(fromDb);
    }

    return '';
  }

  /**
   * Format history entries to prompt text (User: ... / Assistant: ...)
   */
  private formatHistory(
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): string {
    const limited = history.slice(-this.maxHistoryMessages);
    return limited
      .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n');
  }

  /**
   * Load recent messages from database for the session.
   * Returns empty array if DB not configured, not connected, or no conversation/messages.
   */
  private async loadRecentHistoryFromDb(
    context: HookContext,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    if (!this.databaseManager) {
      return [];
    }
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return [];
    }
    const sessionId = context.metadata.get('sessionId');
    const sessionType = context.metadata.get('sessionType');
    if (sessionId == null || sessionType == null) {
      return [];
    }

    try {
      const conversations = adapter.getModel('conversations');
      const conversation = await conversations.findOne({
        sessionId: String(sessionId),
        sessionType,
      });
      if (!conversation) {
        return [];
      }

      const messages = adapter.getModel('messages');
      const all = await messages.find({ conversationId: conversation.id });
      // Sort by createdAt ascending and take last N messages (each turn = user + assistant, so take 2x)
      const sorted = (all as Message[]).sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      const recent = sorted.slice(-this.maxHistoryMessages * 2);

      const result = recent.map((msg) => {
        const meta = msg.metadata as Record<string, unknown> | undefined;
        const role: 'user' | 'assistant' =
          meta?.isBotReply === true ? 'assistant' : 'user';
        return { role, content: msg.content };
      });

      if (result.length > 0) {
        logger.debug(
          `[ConversationHistoryService] Loaded ${result.length} messages from DB for session ${sessionId}`,
        );
      }
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn(
        '[ConversationHistoryService] Failed to load history from DB:',
        err,
      );
      return [];
    }
  }
}
