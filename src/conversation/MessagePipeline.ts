// Message Pipeline - processes messages through the complete flow

import type { APIClient } from '@/api/APIClient';
import type { ContextManager } from '@/context';
import { HookContextBuilder } from '@/context/HookContextBuilder';
import { getReply, getReplyContent, setReply } from '@/context/HookContextHelpers';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { NormalizedMessageEvent } from '@/events/types';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import type { Lifecycle } from './Lifecycle';
import type { MessageProcessingContext, MessageProcessingResult } from './types';

/**
 * Message Pipeline
 * Processes messages through the complete flow using Lifecycle
 */
export class MessagePipeline {
  constructor(
    private lifecycle: Lifecycle,
    private hookManager: HookManager,
    private apiClient: APIClient,
  ) {}

  /**
   * Process message through the complete pipeline
   */
  async process(event: NormalizedMessageEvent, context: MessageProcessingContext): Promise<MessageProcessingResult> {
    try {
      // Create initial hook context using builder
      const hookContext = HookContextBuilder.fromMessage(event, {
        sessionId: context.sessionId,
        sessionType: context.sessionType,
        conversationId: context.conversationId,
        botSelfId: context.botSelfId,
      }).build();

      const messageId = event?.id || event?.messageId || 'unknown';
      logger.info(`[MessagePipeline] Starting message processing | messageId=${messageId} | userId=${event.userId}`);

      // Execute lifecycle
      const success = await this.lifecycle.execute(hookContext);

      if (!success) {
        return { success: false, error: 'Processing interrupted' };
      }

      // Get reply from hook context using helper function
      const reply = getReply(hookContext);
      const postProcessOnly = hookContext.metadata.get('postProcessOnly');

      // Send message if available
      if (reply) {
        logger.info(`[MessagePipeline] Sending reply | messageId=${messageId} | replyLength=${reply.length}`);
        await this.sendMessage(event, reply, hookContext);

        // Save user message and AI reply to conversation history after successful send
        // This ensures history is available for next conversation
        await this.saveConversationMessages(context.sessionId, event.message, reply);
      } else {
        logger.info(`[MessagePipeline] No reply to send | messageId=${messageId} | postProcessOnly=${postProcessOnly}`);
      }

      return {
        success: true,
        reply,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      // Hook: onError
      const errorContext = HookContextBuilder.fromMessage(event).withError(err).build();
      await this.hookManager.execute('onError', errorContext);

      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Send message
   */
  private async sendMessage(event: NormalizedMessageEvent, reply: string, hookContext: HookContext): Promise<void> {
    // Update hook context using helper function
    // If reply field doesn't exist, set it with 'ai' as default source (may be updated by hooks)
    if (!hookContext.reply) {
      setReply(hookContext, reply, 'ai');
    } else {
      // Update text if needed (preserve source and metadata)
      hookContext.reply.text = reply;
    }

    // Hook: onMessageBeforeSend
    const shouldContinue = await this.hookManager.execute('onMessageBeforeSend', hookContext);
    if (!shouldContinue) {
      logger.warn('[MessagePipeline] Message sending interrupted by hook');
      return;
    }

    // Get final reply content (may be modified by hook)
    const replyContent = getReplyContent(hookContext);
    const finalReply = replyContent?.text || reply;

    try {
      // Get conversation context from hook context if available
      const conversationContext = hookContext.context;

      // Check if we need to send card image
      const isCardImage = replyContent?.metadata?.isCardImage;
      const cardImage = replyContent?.metadata?.cardImage;

      let messageToSend: string | ReturnType<MessageBuilder['build']>;

      if (isCardImage && cardImage) {
        // Build image message using MessageBuilder
        const messageBuilder = new MessageBuilder();
        messageBuilder.image({ data: cardImage });
        messageToSend = messageBuilder.build();
        logger.info('[MessagePipeline] Sending card image message');
      } else {
        // Send text message as before
        messageToSend = finalReply;
      }

      // Send message via API
      if (event.messageType === 'private') {
        await this.apiClient.call(
          'send_private_msg',
          {
            user_id: event.userId,
            message: messageToSend,
          },
          'milky',
          10000,
          conversationContext,
        );
      } else if (event.groupId) {
        await this.apiClient.call(
          'send_group_msg',
          {
            group_id: event.groupId,
            message: messageToSend,
          },
          'milky',
          10000,
          conversationContext,
        );
      }

      // Hook: onMessageSent
      await this.hookManager.execute('onMessageSent', hookContext);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');

      // Hook: onError
      const errorContext = HookContextBuilder.fromContext(hookContext).withError(err).build();
      await this.hookManager.execute('onError', errorContext);
    }
  }

  /**
   * Get ContextManager from DI container
   */
  private getContextManager(): ContextManager | null {
    const container = getContainer();
    if (container.isRegistered(DITokens.CONTEXT_MANAGER)) {
      return container.resolve<ContextManager>(DITokens.CONTEXT_MANAGER);
    }

    return null;
  }

  /**
   * Save user message and assistant reply to conversation history
   * This is called after successful reply generation to ensure history is available for next conversation
   */
  private async saveConversationMessages(
    sessionId: string,
    userMessage: string,
    assistantReply: string,
  ): Promise<void> {
    const contextManager = this.getContextManager();
    if (contextManager) {
      try {
        // Save user message first
        await contextManager.addMessage(sessionId, 'user', userMessage);
        // Then save assistant reply
        await contextManager.addMessage(sessionId, 'assistant', assistantReply);
      } catch (error) {
        logger.warn(`[MessagePipeline] Failed to save conversation to history: ${error}`);
      }
    }
  }
}
