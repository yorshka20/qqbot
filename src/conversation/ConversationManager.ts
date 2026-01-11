// Conversation Manager - orchestrates the conversation flow

import type { NormalizedMessageEvent } from '@/events/types';
import type { MessageProcessingResult, MessageProcessingContext } from './types';
import { MessagePipeline } from './MessagePipeline';
import { CommandRouter } from './CommandRouter';
import { logger } from '@/utils/logger';

/**
 * Conversation Manager
 * Main orchestrator for conversation processing
 */
export class ConversationManager {
  private pipeline: MessagePipeline;

  constructor(pipeline: MessagePipeline) {
    this.pipeline = pipeline;
  }

  /**
   * Process message event
   */
  async processMessage(event: NormalizedMessageEvent): Promise<MessageProcessingResult> {
    try {
      logger.debug(
        `[ConversationManager] Processing message from ${event.userId} (${event.messageType})`,
      );

      // Build processing context
      const context: MessageProcessingContext = {
        message: event,
        sessionId: this.getSessionId(event),
        sessionType: event.messageType === 'private' ? 'user' : 'group',
        conversationId: undefined, // Can be loaded from database
      };

      // Process through pipeline
      const result = await this.pipeline.process(event, context);

      if (result.success) {
        logger.debug('[ConversationManager] Message processed successfully');
      } else {
        logger.warn(`[ConversationManager] Message processing failed: ${result.error}`);
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[ConversationManager] Error processing message:', err);

      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Get session ID from event
   */
  private getSessionId(event: NormalizedMessageEvent): string {
    if (event.messageType === 'private') {
      return `user:${event.userId}`;
    } else if (event.groupId) {
      return `group:${event.groupId}`;
    }
    return `unknown:${event.userId}`;
  }
}
