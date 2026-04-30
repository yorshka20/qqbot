// Message Pipeline - processes messages through the complete flow

import type { InternalEventBus } from '@/agenda/InternalEventBus';
import type { ProviderRouter } from '@/ai/routing/ProviderRouter';
import type { ContextManager, ConversationContext } from '@/context';
import { HookContextBuilder } from '@/context/HookContextBuilder';
import { getReply, getReplyContent } from '@/context/HookContextHelpers';
import { enterMessageContext } from '@/context/MessageContextStorage';
import type { NormalizedMessageEvent } from '@/events/types';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { cacheMessage } from '@/message/MessageCache';
import { PERSONA_EVENT_MESSAGE_RECEIVED } from '@/persona';
import { logger } from '@/utils/logger';
import { getLogColorForKey, getLogTag } from '@/utils/messageLogContext';
import type { ConversationConfigService } from './ConversationConfigService';
import type { Lifecycle } from './Lifecycle';
import { deriveSourceFromEvent, type MessageSource } from './sources';
import { getSourceConfig } from './sources/registry';
import type { MessageProcessingContext, MessageProcessingResult } from './types';

/**
 * Message Pipeline
 * Processes messages through the complete flow using Lifecycle.
 * Message sending is handled by SendSystem within the Lifecycle SEND stage.
 * Each process run registers its message context in a Map (keyed by sessionId_messageId); the key is set in
 * async local storage so PromptManager can look up the correct context for this async chain when rendering.
 */
export class MessagePipeline {
  private serialQueues = new Map<MessageSource, Promise<void>>();

  constructor(
    private lifecycle: Lifecycle,
    private hookManager: HookManager,
    private contextManager: ContextManager,
    private conversationConfigService: ConversationConfigService,
    private providerRouter: ProviderRouter,
    /**
     * Optional — when present, the pipeline publishes
     * `PERSONA_EVENT_MESSAGE_RECEIVED` after every successful `lifecycle.execute`
     * so `PersonaService` can translate it into an attention stimulus.
     * Absent in tests / setups without mind.
     */
    private internalEventBus?: InternalEventBus,
  ) {}

  /**
   * Resolve an explicit provider prefix (e.g. `claude, ...`) from the incoming message
   * and stash it on the hook context so ProviderSelectionStage uses the fast path.
   *
   * Full pipeline runs this inside MessageTriggerPlugin during PREPROCESS. Reply-only
   * paths (reaction triggers, direct replies) skip PREPROCESS, so we do the same
   * resolution here — otherwise a message like `[Reply:xxx]claude，...` silently falls
   * through to the default provider.
   */
  private applyProviderPrefix(hookContext: HookContext, event: NormalizedMessageEvent): void {
    const messageText = event.message ?? '';
    if (!messageText) return;
    const result = this.providerRouter.route(messageText);
    if (result.isExplicitPrefix && result.providerName) {
      hookContext.metadata.set('resolvedProviderPrefix', {
        providerName: result.providerName,
        strippedMessage: result.strippedMessage,
      });
    }
  }

  /**
   * Process message through the complete pipeline
   */
  async process(
    event: NormalizedMessageEvent,
    context: MessageProcessingContext,
    source?: MessageSource,
  ): Promise<MessageProcessingResult> {
    const resolvedSource = source ?? context.source ?? deriveSourceFromEvent(event);
    context.source = resolvedSource;
    const cfg = getSourceConfig(resolvedSource);
    if (cfg.serial) {
      const prev = this.serialQueues.get(resolvedSource) ?? Promise.resolve();
      const next = prev.catch(() => undefined).then(() => this._processInner(event, context, resolvedSource));
      this.serialQueues.set(
        resolvedSource,
        next.then(
          () => undefined,
          () => undefined,
        ),
      );
      return next;
    }
    return this._processInner(event, context, resolvedSource);
  }

  private async _processInner(
    event: NormalizedMessageEvent,
    context: MessageProcessingContext,
    resolvedSource: MessageSource,
  ): Promise<MessageProcessingResult> {
    const hookContext = await this.createHookContext(event, context, resolvedSource);
    if (context.responseCallback) {
      hookContext.metadata.set('responseCallback', context.responseCallback);
    }
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
          logger.debug(
            `[MessagePipeline] Starting message processing | messageId=${messageId} | userId=${event.userId} | source=${resolvedSource}`,
          );

          const success = await this.lifecycle.execute(hookContext);
          if (!success) {
            return { success: false, error: 'Processing interrupted' };
          }

          this.publishMindStimulus(event, context);
          return this.buildResult(hookContext, context, event);
        } catch (error) {
          return await this.handleError(error, event, context);
        }
      },
    );
  }

  /**
   * Reply-only path: run PROCESS → PREPARE → SEND then COMPLETE.
   * For replying to existing/historical message; does not cache message, RECEIVE, or Preprocess; no command routing.
   */
  async processReplyOnly(
    event: NormalizedMessageEvent,
    context: MessageProcessingContext,
    source?: MessageSource,
  ): Promise<MessageProcessingResult> {
    const resolvedSource = source ?? context.source ?? deriveSourceFromEvent(event);
    context.source = resolvedSource;
    const hookContext = await this.createHookContext(event, context, resolvedSource);
    const messageId = String(event.id ?? event.messageId ?? 'unknown');
    hookContext.metadata.set('replyOnly', true);
    this.applyProviderPrefix(hookContext, event);
    const contextKey = `${context.sessionId}_${messageId}`;
    const logTag = getLogTag(messageId);
    const logColor = getLogColorForKey(messageId);

    return enterMessageContext(
      contextKey,
      { message: hookContext.message, logTag, logColor, logWholeLineBackground: false },
      async () => {
        try {
          logger.info(`[MessagePipeline] Reply-only | messageId=${messageId} | userId=${event.userId}`);
          const success = await this.lifecycle.executeProcessAndSend(hookContext);
          if (!success) {
            return { success: false, error: 'Processing interrupted' };
          }
          const result = this.buildResult(hookContext, context, event);
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
    source?: MessageSource,
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
      .withSource(source ?? deriveSourceFromEvent(event))
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
   * Build processing result and save conversation messages.
   * Sending is already done by SendSystem in the SEND stage.
   */
  private buildResult(
    hookContext: HookContext,
    context: MessageProcessingContext,
    event: NormalizedMessageEvent,
  ): MessageProcessingResult {
    const replyContent = getReplyContent(hookContext);

    if (replyContent?.segments && replyContent.segments.length > 0) {
      const replyText = getReply(hookContext) ?? '';
      // Save conversation messages asynchronously (non-blocking)
      this.saveConversationMessages(context.sessionId, event.message, replyText, {
        userId: event.userId,
        nickname: event.sender?.nickname ?? event.sender?.card,
      });

      return { success: true, reply: replyText };
    }

    const postProcessOnly = hookContext.metadata.get('postProcessOnly');
    logger.info(`[MessagePipeline] No reply generated | postProcessOnly=${postProcessOnly}`);
    return { success: true };
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
      .withSource(deriveSourceFromEvent(event))
      .withError(err)
      .build();
    await this.hookManager.execute('onError', errorContext);

    return {
      success: false,
      error: err.message,
    };
  }

  /**
   * Publish a message-received event so PersonaService can register an
   * attention spike + relationship row for the speaker. Silently no-ops
   * when the event bus is not present or a subscriber throws — a failure
   * here must never break reply flow.
   *
   * Two-layer gate:
   *   1. **Synthetic exclusion (here)**: synthetic sources (avatar-cmd /
   *      bilibili-danmaku / idle-trigger / bootstrap) carry sentinel
   *      userIds and never produce stimulus.
   *   2. **User config (PersonaService.handleMessageEvent)**: even for real-IM
   *      sources, `PersonaService` checks `mind.applicableSources` so the
   *      user can narrow stimulus to e.g. private DM only.
   *
   * `data.source` is forwarded so PersonaService can apply layer 2 without
   * needing to know about MessageProcessingContext.
   */
  private publishMindStimulus(event: NormalizedMessageEvent, context: MessageProcessingContext): void {
    if (!this.internalEventBus) return;
    const source = context.source;
    if (source !== 'qq-private' && source !== 'qq-group' && source !== 'discord') return;
    try {
      this.internalEventBus.publish({
        type: PERSONA_EVENT_MESSAGE_RECEIVED,
        groupId: event.groupId != null ? String(event.groupId) : '',
        userId: event.userId != null ? String(event.userId) : '',
        botSelfId: context.botSelfId ?? '',
        data: { source },
      });
    } catch (err) {
      logger.debug(`[MessagePipeline] mind stimulus publish failed (non-fatal): ${err}`);
    }
  }

  /**
   * Save user message and assistant reply to conversation history (rich: userId, nickname for consistent format).
   */
  private async saveConversationMessages(
    sessionId: string,
    userMessage: string,
    assistantReply: string,
    options?: { userId?: number | string; nickname?: string },
  ): Promise<void> {
    try {
      await this.contextManager.addMessage(sessionId, 'user', userMessage, options);
      await this.contextManager.addMessage(sessionId, 'assistant', assistantReply);
    } catch (error) {
      logger.warn(`[MessagePipeline] Failed to save conversation to history: ${error}`);
    }
  }
}
