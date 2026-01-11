// Conversation Manager - orchestrates the conversation flow

import type { Config } from '@/core/Config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { NormalizedMessageEvent } from '@/events/types';
import { logger } from '@/utils/logger';
import { MessagePipeline } from './MessagePipeline';
import type {
  MessageProcessingContext,
  MessageProcessingResult,
} from './types';

/**
 * Conversation Manager
 * Main orchestrator for conversation processing
 */
export class ConversationManager {
  private pipeline: MessagePipeline;
  private botSelfId: string;

  constructor(pipeline: MessagePipeline) {
    this.pipeline = pipeline;
    this.botSelfId = this.getBotSelfIdFromConfig();
  }

  /**
   * Get bot self ID from config
   */
  private getBotSelfId(): string {
    return this.botSelfId || this.getBotSelfIdFromConfig();
  }

  private getBotSelfIdFromConfig(): string {
    const container = getContainer();
    if (container.isRegistered(DITokens.CONFIG)) {
      const config = container.resolve<Config>(DITokens.CONFIG);
      const botConfig = config.getConfig();
      return botConfig.bot.selfId;
    }
    return '';
  }

  /**
   * Process message event
   */
  async processMessage(
    event: NormalizedMessageEvent,
  ): Promise<MessageProcessingResult> {
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
        botSelfId: this.getBotSelfId(),
      };

      // Process through pipeline
      const result = await this.pipeline.process(event, context);

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
