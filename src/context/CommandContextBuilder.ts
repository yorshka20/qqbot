// CommandContext Builder
// Provides a unified way to create CommandContext instances

import type { CommandContext, CommandContextMetadata } from '@/command/types';
import type { ConversationContext } from '@/context/types';
import type { HookContext } from '@/hooks/types';

/**
 * CommandContext Builder
 * Provides a fluent API for creating CommandContext instances
 */
export class CommandContextBuilder {
  private userId?: number;
  private groupId?: number;
  private messageType?: 'private' | 'group';
  private rawMessage?: string;
  private messageScene?: string;
  private metadata?: CommandContextMetadata;
  private conversationContext?: ConversationContext;

  private constructor() { }

  /**
   * Create a new builder instance
   */
  static create(): CommandContextBuilder {
    return new CommandContextBuilder();
  }

  /**
   * Create a builder from HookContext
   * This is the most common way to create a CommandContext
   *
   * @param context - The HookContext to extract data from
   * @returns A new builder instance
   */
  static fromHookContext(context: HookContext): CommandContextBuilder {
    const builder = new CommandContextBuilder();
    builder.userId = context.message.userId;
    builder.groupId = context.message.groupId;
    builder.messageType = context.message.messageType;
    builder.rawMessage = context.message.message;
    // Save message scene for temporary session handling (required field)
    builder.messageScene = context.message.messageScene || 'private';
    // Extract conversation context from HookContext
    builder.conversationContext = context.context;

    // Extract metadata from message sender and protocol
    // Protocol is required in CommandContextMetadata, so it must be present
    if (!context.message.protocol) {
      throw new Error('Protocol is required but not found in message event');
    }
    const metadata: CommandContextMetadata = {
      protocol: context.message.protocol,
    };
    if (context.message.sender?.role) {
      metadata.senderRole = context.message.sender.role;
    }
    builder.metadata = metadata;

    return builder;
  }

  /**
   * Set user ID
   */
  withUserId(userId: number): this {
    this.userId = userId;
    return this;
  }

  /**
   * Set group ID
   */
  withGroupId(groupId?: number): this {
    this.groupId = groupId;
    return this;
  }

  /**
   * Set message type
   */
  withMessageType(messageType: 'private' | 'group'): this {
    this.messageType = messageType;
    return this;
  }

  /**
   * Set raw message text
   */
  withRawMessage(rawMessage: string): this {
    this.rawMessage = rawMessage;
    return this;
  }

  /**
   * Set metadata
   */
  withMetadata(metadata: Partial<CommandContextMetadata>): this {
    this.metadata = { ...this.metadata, ...metadata } as CommandContextMetadata;
    return this;
  }

  /**
   * Add a single metadata key-value pair with type safety
   */
  withMetadataEntry<K extends keyof CommandContextMetadata>(
    key: K,
    value: CommandContextMetadata[K],
  ): this {
    if (!this.metadata) {
      this.metadata = {} as CommandContextMetadata;
    }
    this.metadata[key] = value;
    return this;
  }

  /**
   * Set conversation context
   */
  withConversationContext(conversationContext: ConversationContext): this {
    this.conversationContext = conversationContext;
    return this;
  }

  /**
   * Build the CommandContext instance
   * Throws if required fields are missing
   */
  build(): CommandContext {
    if (this.userId === undefined) {
      throw new Error('CommandContextBuilder: userId is required');
    }
    if (this.messageType === undefined) {
      throw new Error('CommandContextBuilder: messageType is required');
    }
    if (this.rawMessage === undefined) {
      throw new Error('CommandContextBuilder: rawMessage is required');
    }
    if (this.messageScene === undefined) {
      throw new Error('CommandContextBuilder: messageScene is required');
    }
    if (this.metadata === undefined || !this.metadata.protocol) {
      throw new Error('CommandContextBuilder: metadata with protocol is required');
    }
    if (this.conversationContext === undefined) {
      throw new Error('CommandContextBuilder: conversationContext is required');
    }

    const context: CommandContext = {
      userId: this.userId,
      messageType: this.messageType,
      rawMessage: this.rawMessage,
      messageScene: this.messageScene,
      metadata: this.metadata,
      conversationContext: this.conversationContext,
    };

    if (this.groupId !== undefined) {
      context.groupId = this.groupId;
    }

    return context;
  }
}
