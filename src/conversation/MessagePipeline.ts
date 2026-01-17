// Message Pipeline - processes messages through the complete flow

import type { APIClient } from '@/api/APIClient';
import { MessageAPI } from '@/api/methods/MessageAPI';
import type { ContextManager, ConversationContext } from '@/context';
import { HookContextBuilder } from '@/context/HookContextBuilder';
import { getReply, getReplyContent, setReply } from '@/context/HookContextHelpers';
import type { NormalizedMessageEvent } from '@/events/types';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { MessageBuilder } from '@/message/MessageBuilder';
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
    const reply = getReply(hookContext);
    const postProcessOnly = hookContext.metadata.get('postProcessOnly');

    if (reply) {
      logger.info(`[MessagePipeline] Sending reply | messageId=${messageId} | replyLength=${reply.length}`);
      await this.sendMessage(event, reply, hookContext);
      await this.saveConversationMessages(context.sessionId, event.message, reply);
    } else {
      logger.info(`[MessagePipeline] No reply to send | messageId=${messageId} | postProcessOnly=${postProcessOnly}`);
    }

    return {
      success: true,
      reply,
    };
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
  private async sendMessage(event: NormalizedMessageEvent, reply: string, hookContext: HookContext): Promise<void> {
    this.updateReplyInContext(hookContext, reply);

    const shouldContinue = await this.hookManager.execute('onMessageBeforeSend', hookContext);
    if (!shouldContinue) {
      logger.warn('[MessagePipeline] Message sending interrupted by hook');
      return;
    }

    try {
      const messageToSend = this.buildMessageToSend(hookContext, reply);
      await this.messageAPI.sendFromContext(messageToSend, event, 10000);
      await this.hookManager.execute('onMessageSent', hookContext);
    } catch (error) {
      await this.handleSendError(error, hookContext);
    }
  }

  /**
   * Update reply in hook context
   */
  private updateReplyInContext(hookContext: HookContext, reply: string): void {
    if (!hookContext.reply) {
      setReply(hookContext, reply, 'ai');
    } else {
      hookContext.reply.text = reply;
    }
  }

  /**
   * Build message to send (text or card image)
   */
  private buildMessageToSend(
    hookContext: HookContext,
    defaultReply: string,
  ): string | MessageSegment[] {
    const replyContent = getReplyContent(hookContext);
    const finalReply = replyContent?.text || defaultReply;
    const isCardImage = replyContent?.metadata?.isCardImage;
    const cardImage = replyContent?.metadata?.cardImage;

    if (isCardImage && cardImage) {
      const messageBuilder = new MessageBuilder();
      messageBuilder.image({ data: cardImage });
      logger.info('[MessagePipeline] Sending card image message');
      return messageBuilder.build();
    }

    return finalReply;
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
