// Conversation History Service - provides conversation history building utility

import type { HookContext } from '@/hooks/types';

/**
 * Conversation History Service
 * Provides utility for building conversation history from hook context
 */
export class ConversationHistoryService {
  constructor(private maxHistoryMessages: number = 10) { }

  /**
   * Build conversation history for prompt
   * @param context - Hook context
   * @returns Conversation history text
   */
  buildConversationHistory(context: HookContext): string {
    const history = context.context?.history || [];
    const limitedHistory = history.slice(-this.maxHistoryMessages);
    return limitedHistory
      .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n');
  }
}
