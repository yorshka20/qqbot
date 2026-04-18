// Message event handler

import type { ConversationManager } from '@/conversation/ConversationManager';
import { getProtocolSelfId } from '@/protocol/ProtocolRegistry';
import { logger } from '@/utils/logger';
import type { NormalizedMessageEvent } from '../types';

export class MessageHandler {
  constructor(private conversationManager: ConversationManager) {}

  /**
   * Handle message event
   */
  async handle(event: NormalizedMessageEvent): Promise<void> {
    // Skip bot echo — bot's sent messages are already counted via onMessageSent
    const selfId = getProtocolSelfId(event.protocol);
    if (selfId && String(event.userId) === String(selfId)) {
      logger.debug(`[MessageHandler] Skipping bot echo from ${event.userId}`);
      // Still process (for DB persistence etc.), just don't log as received
      try {
        await this.conversationManager.processMessage(event);
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Unknown error');
        logger.error('[MessageHandler] Error processing message:', err);
      }
      return;
    }

    // Log message — [STATS] tag: daily stats parses this line to count received messages — do not remove
    if (event.messageType === 'group') {
      const groupName = event.groupName || 'Unknown';
      const senderName = event.sender?.card || event.sender?.nickname || event.userId.toString();
      const role = event.sender?.role || 'member';

      logger.info(
        `[STATS] ===========>[Message] Group: ${groupName} (${event.groupId}) - ${senderName} (${event.userId}, ${role}): ${event.message}`,
      );
    } else {
      logger.info(`[STATS] ===========>[Message] Private from ${event.userId}: ${event.message}`);
    }

    // Process through conversation manager if available
    try {
      await this.conversationManager.processMessage(event);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[MessageHandler] Error processing message:', err);
    } finally {
      logger.debug('======================= [MessageHandler] Message process completed. ========================');
    }
  }
}
