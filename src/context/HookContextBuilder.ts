// HookContext Builder
// Provides a unified way to create HookContext instances

import type { CommandResult, ParsedCommand } from '@/command/types';
import type { NormalizedMessageEvent } from '@/events/types';
import type { HookContextMetadata } from '@/hooks/metadata';
import { MetadataMap } from '@/hooks/metadata';
import type { HookContext, ReplyContent } from '@/hooks/types';
import type { Task, TaskResult } from '@/task/types';
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
  private command?: ParsedCommand;
  private task?: Task;
  private aiResponse?: string;
  private conversationContext?: ConversationContext;
  private result?: TaskResult | CommandResult;
  private error?: Error;
  private metadata: MetadataMap;
  private reply?: ReplyContent;

  private constructor() {
    this.metadata = new MetadataMap();
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

    if (options) {
      // Set metadata values from options (type-safe, only known keys from HookContextMetadata)
      // Using Object.keys ensures we only iterate over defined properties
      for (const key of Object.keys(options) as Array<keyof HookContextMetadata>) {
        const value = options[key];
        if (value !== undefined) {
          builder.metadata.set(key, value);
        }
      }
    }

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

    // Copy metadata (create new MetadataMap to avoid reference issues)
    builder.metadata = new MetadataMap();
    const metadataEntries = Array.from(context.metadata.entries()) as Array<[keyof HookContextMetadata, unknown]>;
    for (const [key, value] of metadataEntries) {
      builder.metadata.set(key, value as HookContextMetadata[typeof key]);
    }

    // Copy reply if exists
    if (context.reply) {
      builder.reply = context.reply;
    }

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
  withTask(task: Task): this {
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
  withResult(result: TaskResult | CommandResult): this {
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
   * Message is required, so it throws if not set
   */
  build(): HookContext {
    if (!this.message) {
      throw new Error(
        'HookContextBuilder: message is required. Use withMessage() or withSyntheticMessage() to set it.',
      );
    }

    const context: HookContext = {
      message: this.message,
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
    if (this.conversationContext !== undefined) {
      context.context = this.conversationContext;
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

    return context;
  }
}
