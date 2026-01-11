// Message event handler

import type { NormalizedMessageEvent } from '../types';
import type { ConversationManager } from '@/conversation/ConversationManager';
import { logger } from '@/utils/logger';

export class MessageHandler {
  private conversationManager: ConversationManager | null = null;

  /**
   * Set conversation manager
   */
  setConversationManager(manager: ConversationManager): void {
    this.conversationManager = manager;
  }

  /**
   * Handle message event
   */
  async handle(event: NormalizedMessageEvent): Promise<void> {
    // Log message
    if (event.messageType === 'group') {
      const groupName = event.groupName || 'Unknown';
      const senderName =
        event.sender?.card || event.sender?.nickname || event.userId.toString();
      const role = event.sender?.role || 'member';

      logger.info(
        `[Message] Group: ${groupName} (${event.groupId}) - ${senderName} (${event.userId}, ${role}): ${event.message}`,
      );
    } else {
      logger.info(`[Message] Private from ${event.userId}: ${event.message}`);
    }

    // Process through conversation manager if available
    if (this.conversationManager) {
      try {
        await this.conversationManager.processMessage(event);
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Unknown error');
        logger.error('[MessageHandler] Error processing message:', err);
      }
    } else {
      logger.warn('[MessageHandler] ConversationManager not set, message not processed');
    }
  }
}
