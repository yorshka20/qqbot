// CommandContext Builder
// Provides a unified way to create CommandContext instances

import type { CommandContext } from '@/command/types';
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
  private metadata?: Record<string, unknown>;

  private constructor() {}

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

    // Extract metadata from message sender if available
    if (context.message.sender?.role) {
      builder.metadata = {
        senderRole: context.message.sender.role,
      };
    }

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
  withMetadata(metadata: Record<string, unknown>): this {
    this.metadata = { ...this.metadata, ...metadata };
    return this;
  }

  /**
   * Add a single metadata key-value pair
   */
  withMetadataEntry(key: string, value: unknown): this {
    if (!this.metadata) {
      this.metadata = {};
    }
    this.metadata[key] = value;
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

    const context: CommandContext = {
      userId: this.userId,
      messageType: this.messageType,
      rawMessage: this.rawMessage,
    };

    if (this.groupId !== undefined) {
      context.groupId = this.groupId;
    }
    if (this.metadata !== undefined && Object.keys(this.metadata).length > 0) {
      context.metadata = this.metadata;
    }

    return context;
  }
}
