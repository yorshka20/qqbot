// Message Pipeline - processes messages through the complete flow

import type { APIClient } from '@/api/APIClient';
import type { SendMessageResult } from '@/api/methods/MessageAPI';
import { MessageAPI } from '@/api/methods/MessageAPI';
import type { ContextManager, ConversationContext } from '@/context';
import { HookContextBuilder } from '@/context/HookContextBuilder';
import { getReply, getReplyContent } from '@/context/HookContextHelpers';
import { enterMessageContext } from '@/context/MessageContextStorage';
import type { NormalizedMessageEvent } from '@/events/types';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { cacheMessage } from '@/message/MessageCache';
import { logger } from '@/utils/logger';
import { getLogColorForKey, getLogTag } from '@/utils/messageLogContext';
import type { ConversationConfigService } from './ConversationConfigService';
import type { Lifecycle } from './Lifecycle';
import type { MessageProcessingContext, MessageProcessingResult } from './types';

/**
 * Message Pipeline
 * Processes messages through the complete flow using Lifecycle.
 * Each process run registers its message context in a Map (keyed by sessionId_messageId); the key is set in
 * async local storage so PromptManager can look up the correct context for this async chain when rendering.
 */
export class MessagePipeline {
  private messageAPI: MessageAPI;

  constructor(
    private lifecycle: Lifecycle,
    private hookManager: HookManager,
    private apiClient: APIClient,
    private contextManager: ContextManager,
    private conversationConfigService: ConversationConfigService,
  ) {
    // Create MessageAPI instance from APIClient
    this.messageAPI = new MessageAPI(this.apiClient);
  }

  /**
   * Process message through the complete pipeline
   */
  async process(event: NormalizedMessageEvent, context: MessageProcessingContext): Promise<MessageProcessingResult> {
    const hookContext = await this.createHookContext(event, context);
    const messageId = String(event.id ?? event.messageId ?? 'unknown');
    const contextKey = `${context.sessionId}_${messageId}`;
    const logTag = getLogTag(messageId);
    const logColor = getLogColorForKey(messageId);

    return enterMessageContext(
      contextKey,
      { message: hookContext.message, logTag, logColor, logWholeLineBackground: false },
      async () => {
        try {
          cacheMessage(event);
          logger.info(
            `[MessagePipeline] Starting message processing | messageId=${messageId} | userId=${event.userId}`,
          );

          const success = await this.lifecycle.execute(hookContext);
          if (!success) {
            return { success: false, error: 'Processing interrupted' };
          }

          return await this.handleReply(event, context, hookContext, messageId);
        } catch (error) {
          return await this.handleError(error, event, context);
        }
      },
    );
  }

  /**
   * Reply-only path: run only PROCESS (ReplySystem, AI reply) then handleReply (send).
   * For replying to existing/historical message; does not cache message, RECEIVE, or Preprocess; no command routing.
   */
  async processReplyOnly(
    event: NormalizedMessageEvent,
    context: MessageProcessingContext,
  ): Promise<MessageProcessingResult> {
    const hookContext = await this.createHookContext(event, context);
    const messageId = String(event.id ?? event.messageId ?? 'unknown');
    hookContext.metadata.set('replyOnly', true);
    const contextKey = `${context.sessionId}_${messageId}`;
    const logTag = getLogTag(messageId);
    const logColor = getLogColorForKey(messageId);

    return enterMessageContext(
      contextKey,
      { message: hookContext.message, logTag, logColor, logWholeLineBackground: false },
      async () => {
        try {
          logger.info(`[MessagePipeline] Reply-only | messageId=${messageId} | userId=${event.userId}`);
          const success = await this.lifecycle.executeProcessOnly(hookContext);
          if (!success) {
            return { success: false, error: 'Processing interrupted' };
          }
          const result = await this.handleReply(event, context, hookContext, messageId);
          if (result.success) {
            await this.lifecycle.runCompleteStage(hookContext, messageId);
          }
          return result;
        } catch (error) {
          return await this.handleError(error, event, context);
        }
      },
    );
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
   * Create initial hook context with conversation context and group-use-forward flag.
   */
  private async createHookContext(
    event: NormalizedMessageEvent,
    context: MessageProcessingContext,
  ): Promise<HookContext> {
    const conversationContext = this.buildConversationContext(event, context);
    const options: Parameters<typeof HookContextBuilder.fromMessage>[1] = {
      sessionId: context.sessionId,
      sessionType: context.sessionType,
      conversationId: context.conversationId,
      botSelfId: context.botSelfId,
      userId: event.userId,
      groupId: event.groupId,
      senderRole: event.sender?.role,
      replyTrigger: context.replyTrigger,
    };
    const hookContext = HookContextBuilder.fromMessage(event, options)
      .withConversationContext(conversationContext)
      .build();
    const groupId = event.groupId != null ? event.groupId.toString() : undefined;
    if (groupId) {
      const groupUseForwardMsg = await this.conversationConfigService.getUseForwardMsg(groupId, 'group');
      hookContext.metadata.set('groupUseForwardMsg', groupUseForwardMsg);
    } else {
      hookContext.metadata.set('groupUseForwardMsg', false);
    }
    return hookContext;
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
      // Use getReply so card replies persist card text (not image) to history/cache
      const replyText = getReply(hookContext) ?? '';
      logger.info(`[MessagePipeline] Sending reply | messageId=${messageId} | replyLength=${replyText.length}`);
      await this.sendMessage(event, hookContext);
      await this.saveConversationMessages(context.sessionId, event.message, replyText, {
        userId: event.userId,
        nickname: event.sender?.nickname ?? event.sender?.card,
      });

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
      conversationId: context.conversationId ?? '',
      botSelfId: context.botSelfId,
      userId: event.userId,
      groupId: event.groupId ?? 0,
      senderRole: event.sender?.role ?? '',
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
   * Send message (normal or as forward). All replies respect the group's useForwardMsg config (Milky only).
   */
  private async sendMessage(event: NormalizedMessageEvent, hookContext: HookContext): Promise<void> {
    const shouldContinue = await this.hookManager.execute('onMessageBeforeSend', hookContext);
    if (!shouldContinue) {
      logger.warn('[MessagePipeline] Message sending interrupted by hook');
      return;
    }

    // handleReply only calls sendMessage when reply has segments; throw if missing so we never silently skip
    const replyContent = getReplyContent(hookContext);
    if (!replyContent || !replyContent.segments || replyContent.segments.length === 0) {
      throw new Error('ReplyContent.segments is required but missing or empty');
    }

    // Forward vs direct is decided upstream when reply is set; pipeline only reads the flag.
    const useForwardActual = event.protocol === 'milky' && replyContent.metadata?.sendAsForward === true;
    logger.debug(
      `[MessagePipeline] sendMessage | useForward=${useForwardActual} | sendAsForward=${replyContent.metadata?.sendAsForward} | protocol=${event.protocol}`,
    );
    let sentMessageResponse: SendMessageResult;

    try {
      if (useForwardActual) {
        const botSelfId = Number(hookContext.metadata.get('botSelfId'));
        if (Number.isNaN(botSelfId) || botSelfId <= 0) {
          throw new Error("Forward message requires bot self ID. Set config.bot.selfId to the bot's own QQ user id.");
        }
        sentMessageResponse = await this.messageAPI.sendForwardFromContext(
          [{ segments: replyContent.segments, senderName: 'Bot' }],
          event,
          10000,
          { botUserId: botSelfId },
        );
      } else {
        sentMessageResponse = await this.messageAPI.sendFromContext(replyContent.segments, event, 10000);
      }
      // Save full API response for plugins to access all fields (e.g., message_id, message_seq, etc.)
      hookContext.sentMessageResponse = sentMessageResponse;
      await this.hookManager.execute('onMessageSent', hookContext);
    } catch (error) {
      await this.handleSendError(error, hookContext);
    }
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
   * Save user message and assistant reply to conversation history (rich: userId, nickname for consistent format).
   */
  private async saveConversationMessages(
    sessionId: string,
    userMessage: string,
    assistantReply: string,
    options?: { userId?: number; nickname?: string },
  ): Promise<void> {
    try {
      await this.contextManager.addMessage(sessionId, 'user', userMessage, options);
      await this.contextManager.addMessage(sessionId, 'assistant', assistantReply);
    } catch (error) {
      logger.warn(`[MessagePipeline] Failed to save conversation to history: ${error}`);
    }
  }
}
