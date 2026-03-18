// ToolExecutionContext Builder
// Provides a unified way to create ToolExecutionContext instances

import type { HookContext } from '@/hooks/types';
import type { ToolExecutionContext, ToolResult } from '@/tools/types';

/**
 * ToolExecutionContext Builder
 * Provides a fluent API for creating ToolExecutionContext instances
 */
export class ToolExecutionContextBuilder {
  private userId?: number;
  private groupId?: number;
  private messageType?: 'private' | 'group';
  private conversationId?: string;
  private messageId?: string;
  private hookContext?: HookContext;
  private toolResults?: Map<string, ToolResult>;
  private metadata?: Record<string, unknown>;

  private constructor() {}

  /**
   * Create a new builder instance
   */
  static create(): ToolExecutionContextBuilder {
    return new ToolExecutionContextBuilder();
  }

  /**
   * Create a builder from HookContext
   * This is the most common way to create a ToolExecutionContext
   * Automatically sets hookContext for executors to access full context
   *
   * @param context - The HookContext to extract data from
   * @returns A new builder instance with hookContext already set
   */
  static fromHookContext(context: HookContext): ToolExecutionContextBuilder {
    const builder = new ToolExecutionContextBuilder();
    builder.userId = context.message.userId;
    builder.groupId = context.message.groupId;
    builder.messageType = context.message.messageType;
    builder.conversationId = context.metadata.get('conversationId');
    builder.messageId = context.message.messageId?.toString();
    builder.hookContext = context; // Set hookContext automatically

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
   * Set hook context
   * This is the primary way for executors to access the full message processing context
   */
  withHookContext(hookContext: HookContext): this {
    this.hookContext = hookContext;
    return this;
  }

  /**
   * Set task results from other tasks
   * Used when reply task needs to incorporate results from other tasks
   */
  withToolResults(toolResults: Map<string, ToolResult>): this {
    this.toolResults = toolResults;
    return this;
  }

  /**
   * Add a single metadata key-value pair
   * Use this for plugin-specific or future extensions
   */
  withMetadataEntry(key: string, value: unknown): this {
    if (!this.metadata) {
      this.metadata = {};
    }
    this.metadata[key] = value;
    return this;
  }

  /**
   * Build the ToolExecutionContext instance
   * Throws if required fields are missing
   */
  build(): ToolExecutionContext {
    if (this.userId === undefined) {
      throw new Error('ToolExecutionContextBuilder: userId is required');
    }
    if (this.messageType === undefined) {
      throw new Error('ToolExecutionContextBuilder: messageType is required');
    }

    const context: ToolExecutionContext = {
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
    if (this.hookContext !== undefined) {
      context.hookContext = this.hookContext;
    }
    if (this.toolResults !== undefined) {
      context.toolResults = this.toolResults;
    }
    if (this.metadata !== undefined && Object.keys(this.metadata).length > 0) {
      context.metadata = this.metadata;
    }

    return context;
  }
}
