// Message API method wrappers

import type { CommandContext } from '@/command/types';
import { ProtocolName } from '@/core/config/protocol';
import type { NormalizedMessageEvent } from '@/events/types';
import type { APIClient } from '../APIClient';

export interface SendMessageResult {
  message_id: number;
}

export class MessageAPI {
  constructor(private apiClient: APIClient) { }

  async sendPrivateMessage(userId: number, message: string | unknown[], protocol: ProtocolName): Promise<number> {
    const result = await this.apiClient.call<SendMessageResult>(
      'send_private_msg',
      {
        user_id: userId,
        message,
      },
      protocol,
    );
    return result.message_id;
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
    return result.message_id;
  }

  /**
   * Send message from context (CommandContext or NormalizedMessageEvent)
   * Automatically extracts protocol, userId, groupId, messageType from context
   * Unified handling of temp session, private, and group messages
   * @param message - Message content to send (string or message segments)
   * @param context - CommandContext or NormalizedMessageEvent
   * @param timeout - Optional timeout in milliseconds (default: 10000)
   * @returns Message ID if available
   */
  async sendFromContext(
    message: string | unknown[],
    context: CommandContext | NormalizedMessageEvent,
    timeout: number = 10000,
  ): Promise<number | void> {
    // Extract protocol from context
    let protocol: ProtocolName;
    if ('metadata' in context && context.metadata?.protocol) {
      // CommandContext case
      protocol = context.metadata.protocol;
    } else if ('protocol' in context && context.protocol) {
      // NormalizedMessageEvent case
      protocol = context.protocol;
    } else {
      throw new Error('Protocol is required but not found in context');
    }

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
      return result.message_id;
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
      return result.message_id;
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
      return result.message_id;
    }

    // If no valid message type found, throw error
    throw new Error('Unable to determine message type from context');
  }
}
