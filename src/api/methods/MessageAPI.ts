// Message API method wrappers

import type { CommandContext } from '@/command/types';
import { ProtocolName } from '@/core/config/protocol';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { Message } from '@/database/models/types';
import type { NormalizedMessageEvent } from '@/events/types';
import { cacheMessage, getCachedMessageBySeq } from '@/message/MessageCache';
import { logger } from '@/utils/logger';
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

  /**
   * @deprecated This method is FORBIDDEN for production use. Only use in debug mode.
   * Use sendFromContext() instead, which properly handles protocol extraction and message type detection.
   * This method is kept only for debug CLI commands.
   */
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

  /**
   * @deprecated This method is FORBIDDEN for production use. Only use in debug mode.
   * Use sendFromContext() instead, which properly handles protocol extraction and message type detection.
   * This method is kept only for debug CLI commands.
   */
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

  /**
   * Get temporary URL for a resource by resource_id (Milky protocol only).
   * Uses get_resource_temp_url API to resolve resource_id when temp_url is expired or missing.
   * @param resourceId - Milky resource_id from image segment
   * @param context - NormalizedMessageEvent or CommandContext for protocol
   * @returns Temporary download URL, or null if protocol is not Milky or API fails
   */
  async getResourceTempUrl(
    resourceId: string,
    context: CommandContext | NormalizedMessageEvent,
  ): Promise<string | null> {
    const protocol = this.extractProtocol(context);
    if (protocol !== 'milky') {
      return null;
    }
    try {
      const response = await this.apiClient.call<{ url: string }>(
        'get_resource_temp_url',
        { resource_id: resourceId },
        protocol,
        15000,
      );
      const url = response?.url;
      if (typeof url === 'string' && url) {
        logger.debug(`[MessageAPI] Got resource temp URL for resource_id=${resourceId.substring(0, 20)}...`);
        return url;
      }
      return null;
    } catch (error) {
      logger.warn(
        `[MessageAPI] get_resource_temp_url failed | resourceId=${resourceId.substring(0, 30)}... | error=${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return null;
    }
  }

  /**
   * Get message from context by messageSeq (for Milky protocol) or messageId (for other protocols)
   * Priority: 1. Memory cache, 2. Database query
   * @param messageSeq - Message sequence (for Milky protocol)
   * @param context - CommandContext or NormalizedMessageEvent
   * @param databaseManager - DatabaseManager for querying database (required)
   * @returns NormalizedMessageEvent if found
   * @throws Error if message not found in all sources
   */
  async getMessageFromContext(
    messageSeq: number,
    context: CommandContext | NormalizedMessageEvent,
    databaseManager: DatabaseManager,
  ): Promise<NormalizedMessageEvent> {
    // Extract protocol from context
    const protocol = this.extractProtocol(context);

    if (protocol !== 'milky') {
      throw new Error(`getMessageFromContext only supports Milky protocol | protocol=${protocol}`);
    }

    // Extract user and group info
    const groupId = context.groupId;
    const userId = context.userId;
    const messageType = context.messageType;
    const messageScene = 'messageScene' in context ? context.messageScene : undefined;

    // For Milky protocol:
    // - Group messages: messageSeq is unique within groupId
    // - Private messages: messageSeq is globally unique (no need for userId/groupId)
    const isGroup = messageType === 'group' && groupId !== undefined;
    const isPrivate = messageType === 'private';

    if (!isGroup && !isPrivate) {
      throw new Error(
        `getMessageFromContext requires groupId for group messages | messageType=${messageType} | groupId=${groupId || 'N/A'}`,
      );
    }

    // Try cache first
    if (isGroup) {
      const cachedMessage = getCachedMessageBySeq(protocol, groupId!, messageSeq, true);
      if (cachedMessage && cachedMessage.groupId === groupId) {
        return cachedMessage;
      }
    } else {
      // For private messages, messageSeq is globally unique
      // Use 0 as placeholder to query cache (private messages cached with userId=0)
      const cachedMessage = getCachedMessageBySeq(protocol, 0, messageSeq, false);
      if (cachedMessage && cachedMessage.messageType === 'private') {
        return cachedMessage;
      }
    }

    const adapter = databaseManager.getAdapter();
    if (!adapter || !adapter.isConnected()) {
      throw new Error(
        `Database not connected | messageSeq=${messageSeq} | protocol=${protocol} | ${isGroup ? `groupId=${groupId}` : 'private'}`,
      );
    }

    const messages = adapter.getModel('messages');
    let dbMessage: Message | null = null;

    // Query by messageSeq
    // Group: protocol + groupId + messageSeq (messageSeq unique within group)
    // Private: protocol + messageSeq + messageType (messageSeq globally unique)
    try {
      if (isGroup) {
        dbMessage = await messages.findOne({
          protocol,
          groupId,
          messageSeq,
        } as Partial<Message>);
      } else {
        // For private messages, messageSeq is globally unique in Milky protocol
        // Query by protocol + messageSeq + messageType only
        dbMessage = await messages.findOne({
          protocol,
          messageSeq,
          messageType: 'private',
        } as Partial<Message>);
      }
    } catch (error) {
      throw new Error(
        `Failed to query message from database | messageSeq=${messageSeq} | protocol=${protocol} | ${isGroup ? `groupId=${groupId}` : 'private'} | error=${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    if (dbMessage) {
      // Convert database Message to NormalizedMessageEvent
      const dbProtocol = dbMessage.protocol;
      const validProtocols: ProtocolName[] = ['milky', 'onebot11', 'satori'];
      const messageProtocol: ProtocolName = validProtocols.includes(dbProtocol as ProtocolName)
        ? (dbProtocol as ProtocolName)
        : protocol;

      // Extract messageSeq from dedicated column (not metadata)
      const messageSeqFromDb = dbMessage.messageSeq;

      // Extract messageScene from metadata (for Milky protocol) or use from context
      let restoredMessageScene: string | undefined = messageScene;
      if (dbMessage.metadata && typeof dbMessage.metadata === 'object') {
        const metadata = dbMessage.metadata as Record<string, unknown>;
        if (typeof metadata.messageScene === 'string') {
          restoredMessageScene = metadata.messageScene;
        }
      }

      const normalizedMessage: NormalizedMessageEvent = {
        id: dbMessage.id,
        type: 'message',
        timestamp: dbMessage.createdAt.getTime(),
        protocol: messageProtocol,
        messageType: dbMessage.messageType,
        userId: dbMessage.userId,
        message: dbMessage.content,
        messageId: dbMessage.messageId ? parseInt(dbMessage.messageId, 10) : undefined,
        messageScene: restoredMessageScene,
      };

      // For Milky protocol, restore messageSeq from metadata
      if (messageProtocol === 'milky' && messageSeqFromDb !== undefined) {
        (normalizedMessage as NormalizedMessageEvent & { messageSeq?: number }).messageSeq = messageSeqFromDb;
        logger.debug(
          `[MessageAPI] Restored messageSeq from database | messageSeq=${messageSeqFromDb} | groupId=${dbMessage.groupId}`,
        );
      }

      // Parse segments from rawContent if available
      // Note: SQLite adapter deserializes jsonFields (including rawContent) so it may already be an array
      if (dbMessage.rawContent) {
        try {
          const segments = Array.isArray(dbMessage.rawContent)
            ? (dbMessage.rawContent as Array<{ type: string; data?: Record<string, unknown> }>)
            : (JSON.parse(dbMessage.rawContent as string) as Array<{
              type: string;
              data?: Record<string, unknown>;
            }>);
          normalizedMessage.segments = segments;
        } catch {
          normalizedMessage.segments = [
            {
              type: 'text',
              data: { text: dbMessage.content },
            },
          ];
        }
      } else {
        normalizedMessage.segments = [
          {
            type: 'text',
            data: { text: dbMessage.content },
          },
        ];
      }

      if (dbMessage.groupId) {
        normalizedMessage.groupId = dbMessage.groupId;
      }

      if (dbMessage.metadata && typeof dbMessage.metadata === 'object') {
        const metadata = dbMessage.metadata as Record<string, unknown>;

        // Restore sender information
        if (metadata.sender && typeof metadata.sender === 'object') {
          const sender = metadata.sender as Record<string, unknown>;
          normalizedMessage.sender = {
            userId: typeof sender.userId === 'number' ? sender.userId : dbMessage.userId,
            nickname: typeof sender.nickname === 'string' ? sender.nickname : undefined,
            card: typeof sender.card === 'string' ? sender.card : undefined,
            role: typeof sender.role === 'string' ? sender.role : undefined,
          };
        }

        // Restore Milky-specific fields (messageScene already restored above)
        if (messageProtocol === 'milky') {
          const milkyMessage = normalizedMessage as NormalizedMessageEvent & {
            groupName?: string;
          };

          if (typeof metadata.groupName === 'string') {
            milkyMessage.groupName = metadata.groupName;
          }
        }
      }

      cacheMessage(normalizedMessage);

      return normalizedMessage;
    }

    throw new Error(
      `Message not found | messageSeq=${messageSeq} | protocol=${protocol} | groupId=${groupId}`,
    );
  }
}
