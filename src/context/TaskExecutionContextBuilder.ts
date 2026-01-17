// TaskExecutionContext Builder
// Provides a unified way to create TaskExecutionContext instances

import type { HookContext } from '@/hooks/types';
import type { TaskExecutionContext } from '@/task/types';

/**
 * TaskExecutionContext Builder
 * Provides a fluent API for creating TaskExecutionContext instances
 */
export class TaskExecutionContextBuilder {
  private userId?: number;
  private groupId?: number;
  private messageType?: 'private' | 'group';
  private conversationId?: string;
  private messageId?: string;
  private metadata?: Record<string, unknown>;

  private constructor() {}

  /**
   * Create a new builder instance
   */
  static create(): TaskExecutionContextBuilder {
    return new TaskExecutionContextBuilder();
  }

  /**
   * Create a builder from HookContext
   * This is the most common way to create a TaskExecutionContext
   *
   * @param context - The HookContext to extract data from
   * @returns A new builder instance
   */
  static fromHookContext(context: HookContext): TaskExecutionContextBuilder {
    const builder = new TaskExecutionContextBuilder();
    builder.userId = context.message.userId;
    builder.groupId = context.message.groupId;
    builder.messageType = context.message.messageType;
    builder.conversationId = context.metadata.get('conversationId');
    builder.messageId = context.message.messageId?.toString();

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
   * Set conversation ID
   */
  withConversationId(conversationId?: string): this {
    this.conversationId = conversationId;
    return this;
  }

  /**
   * Set message ID
   */
  withMessageId(messageId?: string): this {
    this.messageId = messageId;
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
   * Build the TaskExecutionContext instance
   * Throws if required fields are missing
   */
  build(): TaskExecutionContext {
    if (this.userId === undefined) {
      throw new Error('TaskExecutionContextBuilder: userId is required');
    }
    if (this.messageType === undefined) {
      throw new Error('TaskExecutionContextBuilder: messageType is required');
    }

    const context: TaskExecutionContext = {
      userId: this.userId,
      messageType: this.messageType,
    };

    if (this.groupId !== undefined) {
      context.groupId = this.groupId;
    }
    if (this.conversationId !== undefined) {
      context.conversationId = this.conversationId;
    }
    if (this.messageId !== undefined) {
      context.messageId = this.messageId;
    }
    if (this.metadata !== undefined && Object.keys(this.metadata).length > 0) {
      context.metadata = this.metadata;
    }

    return context;
  }
}
