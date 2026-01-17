// Message API method wrappers

import type { CommandContext } from '@/command/types';
import { ProtocolName } from '@/core/config/protocol';
import type { NormalizedMessageEvent } from '@/events/types';
import type { APIClient } from '../APIClient';

export interface SendMessageResult {
  message_id?: number; // Some protocols use message_id
  message_seq?: number; // Milky protocol uses message_seq
}

export class MessageAPI {
  constructor(private apiClient: APIClient) { }

  /**
   * Extract protocol from context (CommandContext or NormalizedMessageEvent)
   * @param context - CommandContext or NormalizedMessageEvent
   * @returns Protocol name
   * @throws Error if protocol is not found in context
   */
  private extractProtocol(context: CommandContext | NormalizedMessageEvent): ProtocolName {
    if ('metadata' in context && context.metadata?.protocol) {
      // CommandContext case
      return context.metadata.protocol;
    } else if ('protocol' in context && context.protocol) {
      // NormalizedMessageEvent case
      return context.protocol;
    } else {
      throw new Error('Protocol is required but not found in context');
    }
  }

  async sendPrivateMessage(userId: number, message: string | unknown[], protocol: ProtocolName): Promise<number> {
    const result = await this.apiClient.call<SendMessageResult>(
      'send_private_msg',
      {
        user_id: userId,
        message,
      },
      protocol,
    );
    // Milky protocol returns message_seq, other protocols may return message_id
    const messageId = result.message_seq ?? result.message_id;
    if (messageId === undefined) {
      throw new Error('API did not return a valid message ID');
    }
    return messageId;
  }

  async sendGroupMessage(groupId: number, message: string | unknown[], protocol: ProtocolName): Promise<number> {
    const result = await this.apiClient.call<SendMessageResult>(
      'send_group_msg',
      {
        group_id: groupId,
        message,
      },
      protocol,
    );
    // Milky protocol returns message_seq, other protocols may return message_id
    const messageId = result.message_seq ?? result.message_id;
    if (messageId === undefined) {
      throw new Error('API did not return a valid message ID');
    }
    return messageId;
  }

  /**
   * Send message from context (CommandContext or NormalizedMessageEvent)
   * Automatically extracts protocol, userId, groupId, messageType from context
   * Unified handling of temp session, private, and group messages
   * @param message - Message content to send (string or message segments)
   * @param context - CommandContext or NormalizedMessageEvent
   * @param timeout - Optional timeout in milliseconds (default: 10000)
   * @returns Full API response containing message ID and other protocol-specific fields
   */
  async sendFromContext(
    message: string | unknown[],
    context: CommandContext | NormalizedMessageEvent,
    timeout: number = 10000,
  ): Promise<SendMessageResult> {
    // Extract protocol from context
    const protocol = this.extractProtocol(context);

    // Extract user and group info
    const userId = context.userId;
    const groupId = context.groupId;
    const messageType = context.messageType;
    const messageScene = 'messageScene' in context ? context.messageScene : undefined;

    // Determine API action and params based on message type and scene
    // Handle temporary session messages (messageScene === 'temp')
    // Temporary sessions should use private message API with group_id context
    if (messageScene === 'temp' && groupId) {
      const result = await this.apiClient.call<SendMessageResult>(
        'send_private_msg',
        {
          user_id: userId,
          group_id: groupId, // Include group_id for temporary session context
          message,
        },
        protocol,
        timeout,
      );
      // Return full response for plugins to access all fields
      return result;
    } else if (messageType === 'private') {
      const result = await this.apiClient.call<SendMessageResult>(
        'send_private_msg',
        {
          user_id: userId,
          message,
        },
        protocol,
        timeout,
      );
      // Return full response for plugins to access all fields
      return result;
    } else if (groupId) {
      const result = await this.apiClient.call<SendMessageResult>(
        'send_group_msg',
        {
          group_id: groupId,
          message,
        },
        protocol,
        timeout,
      );
      // Return full response for plugins to access all fields
      return result;
    }

    // If no valid message type found, throw error
    throw new Error('Unable to determine message type from context');
  }

  /**
   * Recall message from context (CommandContext or NormalizedMessageEvent)
   * Automatically extracts protocol, userId, groupId, messageType from context
   * Unified handling of temp session, private, and group messages
   * @param messageId - Message ID or message sequence to recall
   * @param context - CommandContext or NormalizedMessageEvent
   * @param timeout - Optional timeout in milliseconds (default: 10000)
   */
  async recallFromContext(
    messageId: number,
    context: CommandContext | NormalizedMessageEvent,
    timeout: number = 10000,
  ): Promise<void> {
    // Extract protocol from context
    const protocol = this.extractProtocol(context);

    // Extract user and group info
    const userId = context.userId;
    const groupId = context.groupId;
    const messageType = context.messageType;
    const messageScene = 'messageScene' in context ? context.messageScene : undefined;

    // Determine API action and params based on message type and scene
    // Handle temporary session messages (messageScene === 'temp')
    // Temporary sessions should use private message recall API
    if (messageScene === 'temp' || messageType === 'private') {
      await this.apiClient.call(
        'recall_private_message',
        {
          user_id: userId,
          message_seq: messageId, // Use message_id as message_seq (supported by MilkyAPIConverter)
        },
        protocol,
        timeout,
      );
    } else if (groupId) {
      await this.apiClient.call(
        'recall_group_message',
        {
          group_id: groupId,
          message_seq: messageId,
        },
        protocol,
        timeout,
      );
    } else {
      throw new Error('Unable to determine message type from context for recall');
    }
  }
}
