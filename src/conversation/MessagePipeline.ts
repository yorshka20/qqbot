// Message Pipeline - processes messages through the complete flow

import { extractTextFromSegments } from '@/ai/utils/imageUtils';
import type { APIClient } from '@/api/APIClient';
import { MessageAPI } from '@/api/methods/MessageAPI';
import type { ContextManager, ConversationContext } from '@/context';
import { HookContextBuilder } from '@/context/HookContextBuilder';
import { getReplyContent } from '@/context/HookContextHelpers';
import type { NormalizedMessageEvent } from '@/events/types';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { cacheMessage } from '@/message/MessageCache';
import type { MessageSegment } from '@/message/types';
import { logger } from '@/utils/logger';
import type { Lifecycle } from './Lifecycle';
import type { MessageProcessingContext, MessageProcessingResult } from './types';

/**
 * Message Pipeline
 * Processes messages through the complete flow using Lifecycle
 */
export class MessagePipeline {
  private messageAPI: MessageAPI;

  constructor(
    private lifecycle: Lifecycle,
    private hookManager: HookManager,
    private apiClient: APIClient,
    private contextManager: ContextManager,
  ) {
    // Create MessageAPI instance from APIClient
    this.messageAPI = new MessageAPI(this.apiClient);
  }

  /**
   * Process message through the complete pipeline
   */
  async process(event: NormalizedMessageEvent, context: MessageProcessingContext): Promise<MessageProcessingResult> {
    try {
      // Cache message early for quick lookup (e.g., for reply segments)
      cacheMessage(event);

      const hookContext = this.createHookContext(event, context);
      const messageId = String(event.id ?? event.messageId ?? 'unknown');
      logger.info(`[MessagePipeline] Starting message processing | messageId=${messageId} | userId=${event.userId}`);

      const success = await this.lifecycle.execute(hookContext);
      if (!success) {
        return { success: false, error: 'Processing interrupted' };
      }

      return await this.handleReply(event, context, hookContext, messageId);
    } catch (error) {
      return await this.handleError(error, event, context);
    }
  }

  /**
   * Build conversation context from event and processing context
   */
  private buildConversationContext(
    event: NormalizedMessageEvent,
    context: MessageProcessingContext,
  ): ConversationContext {
    return this.contextManager.buildContext(event.message, {
      sessionId: context.sessionId,
      sessionType: context.sessionType,
      userId: event.userId,
      groupId: event.groupId,
    });
  }

  /**
   * Create initial hook context with conversation context
   */
  private createHookContext(
    event: NormalizedMessageEvent,
    context: MessageProcessingContext,
  ): HookContext {
    const conversationContext = this.buildConversationContext(event, context);
    return HookContextBuilder.fromMessage(event, {
      sessionId: context.sessionId,
      sessionType: context.sessionType,
      conversationId: context.conversationId,
      botSelfId: context.botSelfId,
    })
      .withConversationContext(conversationContext)
      .build();
  }

  /**
   * Handle reply from hook context
   */
  private async handleReply(
    event: NormalizedMessageEvent,
    context: MessageProcessingContext,
    hookContext: HookContext,
    messageId: string,
  ): Promise<MessageProcessingResult> {
    const replyContent = getReplyContent(hookContext);
    const postProcessOnly = hookContext.metadata.get('postProcessOnly');

    if (replyContent?.segments && replyContent.segments.length > 0) {
      const replyText = extractTextFromSegments(replyContent.segments);
      logger.info(`[MessagePipeline] Sending reply | messageId=${messageId} | replyLength=${replyText.length}`);
      await this.sendMessage(event, hookContext);
      await this.saveConversationMessages(context.sessionId, event.message, replyText);

      return {
        success: true,
        reply: replyText,
      };
    } else {
      logger.info(`[MessagePipeline] No reply to send | messageId=${messageId} | postProcessOnly=${postProcessOnly}`);
      return {
        success: true,
      };
    }
  }

  /**
   * Handle error during message processing
   */
  private async handleError(
    error: unknown,
    event: NormalizedMessageEvent,
    context: MessageProcessingContext,
  ): Promise<MessageProcessingResult> {
    const err = error instanceof Error ? error : new Error('Unknown error');
    const conversationContext = this.buildConversationContext(event, context);
    const errorContext = HookContextBuilder.fromMessage(event, {
      sessionId: context.sessionId,
      sessionType: context.sessionType,
      conversationId: context.conversationId,
      botSelfId: context.botSelfId,
    })
      .withConversationContext(conversationContext)
      .withError(err)
      .build();
    await this.hookManager.execute('onError', errorContext);

    return {
      success: false,
      error: err.message,
    };
  }

  /**
   * Send message
   */
  private async sendMessage(event: NormalizedMessageEvent, hookContext: HookContext): Promise<void> {
    const shouldContinue = await this.hookManager.execute('onMessageBeforeSend', hookContext);
    if (!shouldContinue) {
      logger.warn('[MessagePipeline] Message sending interrupted by hook');
      return;
    }

    try {
      const messageToSend = this.buildMessageToSend(hookContext);
      const sentMessageResponse = await this.messageAPI.sendFromContext(messageToSend, event, 10000);
      // Save full API response for plugins to access all fields (e.g., message_id, message_seq, etc.)
      hookContext.sentMessageResponse = sentMessageResponse;
      await this.hookManager.execute('onMessageSent', hookContext);
    } catch (error) {
      await this.handleSendError(error, hookContext);
    }
  }


  /**
   * Build message to send (always returns segments)
   */
  private buildMessageToSend(hookContext: HookContext): MessageSegment[] {
    const replyContent = getReplyContent(hookContext);

    // Segments is a required field, so it should always exist if replyContent exists
    if (!replyContent || !replyContent.segments || replyContent.segments.length === 0) {
      throw new Error('ReplyContent.segments is required but missing or empty');
    }

    logger.info(`[MessagePipeline] Sending message with ${replyContent.segments.length} segment(s)`);
    return replyContent.segments;
  }

  /**
   * Handle error during message sending
   */
  private async handleSendError(error: unknown, hookContext: HookContext): Promise<void> {
    const err = error instanceof Error ? error : new Error('Unknown error');
    const errorContext = HookContextBuilder.fromContext(hookContext).withError(err).build();
    await this.hookManager.execute('onError', errorContext);
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
    try {
      await this.contextManager.addMessage(sessionId, 'user', userMessage);
      await this.contextManager.addMessage(sessionId, 'assistant', assistantReply);
    } catch (error) {
      logger.warn(`[MessagePipeline] Failed to save conversation to history: ${error}`);
    }
  }
}
