// HookContext Builder
// Provides a unified way to create HookContext instances

import type { CommandResult, ParsedCommand } from '@/command/types';
import type { NormalizedMessageEvent, NormalizedNoticeEvent } from '@/events/types';
import type { HookContextMetadata, HookMetadataMap } from '@/hooks/metadata';
import { createDefaultHookMetadata } from '@/hooks/metadata';
import type { HookContext, ReplyContent } from '@/hooks/types';
import type { ToolCall, ToolResult } from '@/tools/types';
import type { ConversationContext } from './types';

/**
 * Options for creating HookContext from message event
 * Uses HookContextMetadata as the single source of truth
 */
export type MessageContextOptions = Partial<HookContextMetadata>;

/**
 * HookContext Builder
 * Provides a fluent API for creating HookContext instances
 */
export class HookContextBuilder {
  private message?: NormalizedMessageEvent;
  private notice?: NormalizedNoticeEvent;
  private command?: ParsedCommand;
  private task?: ToolCall;
  private aiResponse?: string;
  private conversationContext?: ConversationContext;
  private result?: ToolResult | CommandResult;
  private error?: Error;
  private metadata: HookMetadataMap;
  private reply?: ReplyContent;

  private constructor() {
    this.metadata = createDefaultHookMetadata();
  }

  /**
   * Create a new builder instance
   */
  static create(): HookContextBuilder {
    return new HookContextBuilder();
  }

  /**
   * Create a builder from a message event
   * This is the most common way to create a HookContext
   *
   * @param message - The normalized message event
   * @param options - Optional metadata and context options
   * @returns A new builder instance
   */
  static fromMessage(message: NormalizedMessageEvent, options?: MessageContextOptions): HookContextBuilder {
    const builder = new HookContextBuilder();
    builder.message = message;
    // All required metadata fields get defaults; options override
    builder.metadata = createDefaultHookMetadata(options ?? {});
    return builder;
  }

  /**
   * Create a builder from an existing HookContext
   * Useful for extending or modifying existing contexts (e.g., adding error)
   *
   * @param context - The existing HookContext
   * @returns A new builder instance with context data copied
   */
  static fromContext(context: HookContext): HookContextBuilder {
    const builder = new HookContextBuilder();
    builder.message = context.message;
    builder.command = context.command;
    builder.task = context.task;
    builder.aiResponse = context.aiResponse;
    builder.conversationContext = context.context;
    builder.result = context.result;
    builder.error = context.error;
    builder.metadata = context.metadata.clone();
    builder.reply = context.reply;
    builder.notice = context.notice;
    return builder;
  }

  /**
   * Create a builder from a notice event (for onNoticeReceived hook).
   * Sets a minimal message and conversation context for logging; hook handlers should use context.notice.
   */
  static fromNotice(notice: NormalizedNoticeEvent): HookContextBuilder {
    const builder = new HookContextBuilder();
    builder.notice = notice;
    const sessionType = notice.messageType === 'private' ? 'user' : 'group';
    const userId = notice.userId ?? 0;
    const groupId = notice.groupId ?? 0;
    const sessionId = sessionType === 'group' && notice.groupId != null ? `group:${notice.groupId}` : `user:${userId}`;
    builder.metadata = createDefaultHookMetadata({
      sessionId,
      sessionType,
      userId,
      groupId,
      senderRole: '',
    });
    const messageType = notice.messageType ?? 'group';
    builder.message = {
      id: `notice:${notice.noticeType}`,
      type: 'message',
      timestamp: notice.timestamp ?? Date.now(),
      protocol: notice.protocol ?? 'unknown',
      userId,
      groupId: notice.groupId,
      messageType,
      message: '',
      segments: [],
    } as NormalizedMessageEvent;
    builder.conversationContext = {
      userMessage: '',
      history: [],
      userId,
      groupId: notice.groupId,
      messageType,
      metadata: new Map(),
    };
    return builder;
  }

  /**
   * Set the message event
   */
  withMessage(message: NormalizedMessageEvent): this {
    this.message = message;
    return this;
  }

  /**
   * Set the notice event (for onNoticeReceived hook context)
   */
  withNotice(notice: NormalizedNoticeEvent): this {
    this.notice = notice;
    return this;
  }

  /**
   * Set a synthetic message (for command handlers that create temporary messages)
   */
  withSyntheticMessage(message: Partial<NormalizedMessageEvent>): this {
    this.message = {
      id: message.id || `synthetic_${Date.now()}`,
      type: 'message',
      timestamp: message.timestamp || Date.now(),
      protocol: message.protocol || 'command',
      userId: message.userId,
      groupId: message.groupId,
      messageId: message.messageId,
      messageType: message.messageType || 'private',
      message: message.message || '',
      segments: message.segments || [],
    } as NormalizedMessageEvent;
    return this;
  }

  /**
   * Set the command
   */
  withCommand(command: ParsedCommand): this {
    this.command = command;
    return this;
  }

  /**
   * Set the task
   */
  withTask(task: ToolCall): this {
    this.task = task;
    return this;
  }

  /**
   * Set the AI response
   */
  withAIResponse(aiResponse: string): this {
    this.aiResponse = aiResponse;
    return this;
  }

  /**
   * Set the conversation context
   */
  withConversationContext(context: ConversationContext): this {
    this.conversationContext = context;
    return this;
  }

  /**
   * Set the execution result
   */
  withResult(result: ToolResult | CommandResult): this {
    this.result = result;
    return this;
  }

  /**
   * Set the error
   */
  withError(error: Error): this {
    this.error = error;
    return this;
  }

  /**
   * Set metadata value
   */
  withMetadata<K extends keyof HookContextMetadata>(key: K, value: HookContextMetadata[K]): this {
    this.metadata.set(key, value);
    return this;
  }

  /**
   * Set multiple metadata values at once
   */
  withMetadataMap(metadata: Partial<Record<keyof HookContextMetadata, unknown>>): this {
    for (const key of Object.keys(metadata) as Array<keyof HookContextMetadata>) {
      const value = metadata[key];
      if (value !== undefined) {
        this.metadata.set(key, value as HookContextMetadata[typeof key]);
      }
    }
    return this;
  }

  /**
   * Build the HookContext instance
   * Message and conversationContext are required; throws if not set
   */
  build(): HookContext {
    if (!this.message) {
      throw new Error(
        'HookContextBuilder: message is required. Use withMessage() or withSyntheticMessage() to set it.',
      );
    }
    if (!this.conversationContext) {
      throw new Error('HookContextBuilder: conversationContext is required. Use withConversationContext() to set it.');
    }

    const context: HookContext = {
      message: this.message,
      context: this.conversationContext,
      metadata: this.metadata,
    };

    if (this.command !== undefined) {
      context.command = this.command;
    }
    if (this.task !== undefined) {
      context.task = this.task;
    }
    if (this.aiResponse !== undefined) {
      context.aiResponse = this.aiResponse;
    }
    if (this.result !== undefined) {
      context.result = this.result;
    }
    if (this.error !== undefined) {
      context.error = this.error;
    }
    if (this.reply !== undefined) {
      context.reply = this.reply;
    }
    if (this.notice !== undefined) {
      context.notice = this.notice;
    }

    return context;
  }
}
