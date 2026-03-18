// Message API method wrappers

import type { CommandContext } from '@/command/types';
import type { ProtocolName } from '@/core/config/types/protocol';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { Message } from '@/database/models/types';
import type { NormalizedMessageEvent, NormalizedNoticeEvent } from '@/events/types';
import { cacheMessage, getCachedMessageBySeq } from '@/message/MessageCache';
import type { MessageSegment } from '@/message/types';
import { segmentsToMilkyOutgoing } from '@/protocol/milky/MilkySegmentConverter';
import { logger } from '@/utils/logger';
import type { APIClient } from '../APIClient';

export interface SendMessageResult {
  message_id?: number; // Some protocols use message_id
  message_seq?: number; // Milky protocol uses message_seq
}

/** One logical message in a forward: segments plus optional sender display. */
export interface ForwardMessageInput {
  segments: MessageSegment[];
  senderName?: string;
  senderId?: number;
}

/** Context types supported by extractProtocol, recallFromContext, getMessageFromContext. */
export type MessageAPIContext = CommandContext | NormalizedMessageEvent | NormalizedNoticeEvent;

/** Extracted fields from MessageAPIContext for API calls (notice may have optional groupId/messageType). */
interface ExtractedContextFields {
  protocol: ProtocolName;
  userId?: number;
  groupId?: number;
  messageType?: 'private' | 'group';
  messageScene?: string;
}

export class MessageAPI {
  constructor(private apiClient: APIClient) {}

  /**
   * Extract protocol from context (CommandContext, NormalizedMessageEvent, or NormalizedNoticeEvent).
   * CommandContext has protocol on metadata; event contexts have protocol on the object (BaseEvent).
   */
  private extractProtocol(context: MessageAPIContext): ProtocolName {
    if ('metadata' in context && context.metadata?.protocol) {
      return context.metadata.protocol;
    }
    if ('protocol' in context && context.protocol) {
      return context.protocol;
    }
    throw new Error('Protocol is required but not found in context');
  }

  /**
   * Extract protocol, groupId, messageType, userId, messageScene from any supported context.
   * NormalizedNoticeEvent may have groupId/messageType set by normalizer for group-related notices.
   */
  private extractContextFields(context: MessageAPIContext): ExtractedContextFields {
    const protocol = this.extractProtocol(context);
    const userId = 'userId' in context ? context.userId : undefined;
    const groupId = 'groupId' in context ? context.groupId : undefined;
    const messageType = 'messageType' in context ? context.messageType : undefined;
    const messageScene =
      'messageScene' in context && typeof context.messageScene === 'string' ? context.messageScene : undefined;
    return { protocol, userId, groupId, messageType, messageScene };
  }

  /**
   * Send a private message directly by userId and protocol.
   * Use this when no message context is available (e.g. AgentLoop scheduled tasks).
   * When a CommandContext or NormalizedMessageEvent is available, prefer sendFromContext().
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
   * Send a group message directly by groupId and protocol.
   * Use this when no message context is available (e.g. AgentLoop scheduled tasks).
   * When a CommandContext or NormalizedMessageEvent is available, prefer sendFromContext().
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

    // Convert internal MessageSegment[] to protocol-specific format.
    // Forward messages use sendForwardFromContext (which converts separately), so
    // any array reaching here is always internal MessageSegment[].
    const protocolMessage: string | unknown[] =
      protocol === 'milky' && Array.isArray(message) ? segmentsToMilkyOutgoing(message as MessageSegment[]) : message;

    // Extract user and group info
    const userId = context.userId;
    const groupId = context.groupId;
    const messageType = context.messageType;
    const messageScene = 'messageScene' in context ? context.messageScene : undefined;

    // Determine API action and params based on message type and scene
    // Handle temporary session messages (messageScene === 'temp')
    // Temporary sessions should use private message API with group_id context
    if (messageScene === 'temp' && groupId) {
      return this.apiClient.call<SendMessageResult>(
        'send_private_msg',
        {
          user_id: userId,
          group_id: groupId, // Include group_id for temporary session context
          message: protocolMessage,
        },
        protocol,
        timeout,
      );
    } else if (messageType === 'private') {
      return this.apiClient.call<SendMessageResult>(
        'send_private_msg',
        {
          user_id: userId,
          message: protocolMessage,
        },
        protocol,
        timeout,
      );
    } else if (groupId) {
      return this.apiClient.call<SendMessageResult>(
        'send_group_msg',
        {
          group_id: groupId,
          message: protocolMessage,
        },
        protocol,
        timeout,
      );
    }

    // If no valid message type found, throw error
    throw new Error('Unable to determine message type from context');
  }

  /**
   * Build the forward segment from ForwardMessageInput[].
   * Shared by sendForwardFromContext and sendForwardMessage.
   */
  private buildForwardSegment(messages: ForwardMessageInput[], botUserId: number) {
    const nodes = messages.map((m) => {
      const milkySegments = segmentsToMilkyOutgoing(m.segments);
      return {
        user_id: m.senderId ?? botUserId,
        sender_name: m.senderName ?? 'Bot',
        segments: milkySegments,
      };
    });
    return {
      type: 'forward' as const,
      data: { messages: nodes },
    };
  }

  /**
   * Send a forward message directly by target type and id (Milky protocol only, no context needed).
   * Use this when no CommandContext or NormalizedMessageEvent is available.
   *
   * @param target - Target type ('user' or 'group') and numeric id
   * @param messages - Array of messages to include in the forward
   * @param protocol - Protocol name (must be 'milky')
   * @param options - botUserId is required: the bot's own QQ user id (positive number)
   * @param timeout - Optional timeout in milliseconds (default: 10000)
   * @returns Full API response (e.g. message_seq for Milky)
   */
  async sendForwardMessage(
    target: { type: 'user' | 'group'; id: number },
    messages: ForwardMessageInput[],
    protocol: ProtocolName,
    options: { botUserId: number },
    timeout: number = 10000,
  ): Promise<SendMessageResult> {
    if (protocol !== 'milky') {
      throw new Error('Forward message is only supported for Milky protocol');
    }
    if (!messages || messages.length === 0) {
      throw new Error('sendForwardMessage requires at least one message');
    }
    const botUserId = options.botUserId;
    if (!botUserId || botUserId <= 0) {
      throw new Error(
        "Forward message requires options.botUserId to be the bot's own QQ user id (positive number). Set config.bot.selfId.",
      );
    }

    const forwardSegment = this.buildForwardSegment(messages, botUserId);

    const action = target.type === 'user' ? 'send_private_msg' : 'send_group_msg';
    const targetKey = target.type === 'user' ? 'user_id' : 'group_id';

    return this.apiClient.call<SendMessageResult>(
      action,
      { [targetKey]: target.id, message: [forwardSegment] },
      protocol,
      timeout,
    );
  }

  /**
   * Send a single forward message containing multiple logical messages (Milky protocol only).
   * Each item in messages becomes one node in the forward; the user sees one forward card and can expand to see all.
   * Image segments are sent as http(s) URI so the protocol implementation can download to its temp file (LLOneBot fails with base64: ENOENT when opening temp file).
   *
   * @param messages - Array of messages to include in the forward (each: segments + optional senderName/senderId)
   * @param context - CommandContext (use originalMessage for target; bot from conversationContext) or NormalizedMessageEvent
   * @param timeout - Optional timeout in milliseconds (default: 10000)
   * @param options - botUserId is required: the bot's own QQ user id (must not be 0)
   * @returns Full API response (e.g. message_seq for Milky)
   */
  async sendForwardFromContext(
    messages: ForwardMessageInput[],
    context: CommandContext | NormalizedMessageEvent,
    timeout: number = 10000,
    options?: { botUserId?: number },
  ): Promise<SendMessageResult> {
    const { protocol, userId, groupId, messageType, messageScene } = this.extractContextFields(context);
    if (protocol !== 'milky') {
      throw new Error('Forward message is only supported for Milky protocol');
    }
    if (!messages || messages.length === 0) {
      throw new Error('sendForwardFromContext requires at least one message');
    }

    // botUserId is required for forward; must be the bot's own QQ user id (not 0)
    const rawBot = options?.botUserId;
    const botUserId = typeof rawBot === 'number' && !Number.isNaN(rawBot) && rawBot > 0 ? rawBot : undefined;
    if (botUserId === undefined) {
      throw new Error(
        "Forward message requires options.botUserId to be the bot's own QQ user id (positive number). Set config.bot.selfId.",
      );
    }

    const forwardSegment = this.buildForwardSegment(messages, botUserId);

    logger.debug(
      `[MessageAPI] sendForwardFromContext | group_id=${groupId} | nodes=${messages.length} | botUserId=${botUserId} | firstNodeSegments=${messages[0]?.segments?.length ?? 0}`,
    );

    if (messageScene === 'temp' && groupId) {
      return this.apiClient.call<SendMessageResult>(
        'send_private_msg',
        { user_id: userId, group_id: groupId, message: [forwardSegment] },
        protocol,
        timeout,
      );
    }
    if (messageType === 'private') {
      return this.apiClient.call<SendMessageResult>(
        'send_private_msg',
        { user_id: userId, message: [forwardSegment] },
        protocol,
        timeout,
      );
    }
    if (groupId) {
      return this.apiClient.call<SendMessageResult>(
        'send_group_msg',
        { group_id: groupId, message: [forwardSegment] },
        protocol,
        timeout,
      );
    }
    throw new Error('Unable to determine message type from context for forward');
  }

  /**
   * Recall message from context (CommandContext, NormalizedMessageEvent, or NormalizedNoticeEvent).
   * Automatically extracts protocol, userId, groupId, messageType from context.
   * @param messageId - Message ID or message sequence to recall
   * @param context - MessageAPIContext (notice must have groupId/messageType set by normalizer for group recall)
   * @param timeout - Optional timeout in milliseconds (default: 10000)
   */
  async recallFromContext(messageId: number, context: MessageAPIContext, timeout: number = 10000): Promise<void> {
    const { protocol, userId, groupId, messageType, messageScene } = this.extractContextFields(context);

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
   * Build NormalizedMessageEvent from a DB Message. Single place for this conversion so we don't duplicate
   * the same logic in two call sites (cache hit with image → prefer DB for bot reply, and cache miss → load from DB).
   * Bot reply: never uses rawContent for segments so referenced card shows cardText only.
   */
  private buildNormalizedFromDbMessage(
    dbMessage: Message,
    protocol: ProtocolName,
    messageScene?: string,
  ): NormalizedMessageEvent {
    const dbProtocol = dbMessage.protocol;
    const validProtocols: ProtocolName[] = ['milky', 'onebot11', 'satori'];
    const messageProtocol: ProtocolName = validProtocols.includes(dbProtocol as ProtocolName)
      ? (dbProtocol as ProtocolName)
      : protocol;

    const messageSeqFromDb = dbMessage.messageSeq;
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

    if (messageProtocol === 'milky' && messageSeqFromDb !== undefined) {
      (normalizedMessage as NormalizedMessageEvent & { messageSeq?: number }).messageSeq = messageSeqFromDb;
      logger.debug(
        `[MessageAPI] Restored messageSeq from database | messageSeq=${messageSeqFromDb} | groupId=${dbMessage.groupId}`,
      );
    }

    // Bot reply (e.g. card image): never use rawContent for segments; use content only so referenced message shows cardText, not image. Card image is never stored in DB or cache.
    const isBotReply =
      dbMessage.metadata && typeof dbMessage.metadata === 'object' && dbMessage.metadata.isBotReply === true;
    if (isBotReply) {
      normalizedMessage.segments = [{ type: 'text', data: { text: dbMessage.content } }];
    } else {
      if (dbMessage.rawContent) {
        try {
          const segments = Array.isArray(dbMessage.rawContent)
            ? (dbMessage.rawContent as Array<{ type: string; data?: Record<string, unknown> }>)
            : (JSON.parse(dbMessage.rawContent as string) as Array<{ type: string; data?: Record<string, unknown> }>);
          normalizedMessage.segments = segments;
        } catch {
          normalizedMessage.segments = [{ type: 'text', data: { text: dbMessage.content } }];
        }
      } else {
        logger.debug(
          `[MessageAPI] Restored message has no rawContent, using text fallback only | messageSeq=${messageSeqFromDb}`,
        );
        normalizedMessage.segments = [{ type: 'text', data: { text: dbMessage.content } }];
      }
    }

    if (dbMessage.groupId) {
      normalizedMessage.groupId = dbMessage.groupId;
    }

    if (dbMessage.metadata && typeof dbMessage.metadata === 'object') {
      const metadata = dbMessage.metadata as Record<string, unknown>;
      if (metadata.sender && typeof metadata.sender === 'object') {
        const sender = metadata.sender as Record<string, unknown>;
        normalizedMessage.sender = {
          userId: typeof sender.userId === 'number' ? sender.userId : dbMessage.userId,
          nickname: typeof sender.nickname === 'string' ? sender.nickname : undefined,
          card: typeof sender.card === 'string' ? sender.card : undefined,
          role: typeof sender.role === 'string' ? sender.role : undefined,
        };
      }
      if (messageProtocol === 'milky') {
        const milkyMessage = normalizedMessage as NormalizedMessageEvent & { groupName?: string };
        if (typeof (metadata as { groupName?: string }).groupName === 'string') {
          milkyMessage.groupName = (metadata as { groupName?: string }).groupName;
        }
      }
    }

    return normalizedMessage;
  }

  /**
   * Get message from context by messageSeq (for Milky protocol) or messageId (for other protocols).
   * Priority: 1. Memory cache, 2. Database query.
   * @param messageSeq - Message sequence (for Milky protocol)
   * @param context - MessageAPIContext (notice must have groupId/messageType set by normalizer for group lookup)
   * @param databaseManager - DatabaseManager for querying database (required)
   * @returns NormalizedMessageEvent if found
   * @throws Error if message not found in all sources
   */
  async getMessageFromContext(
    messageSeq: number,
    context: MessageAPIContext,
    databaseManager: DatabaseManager,
  ): Promise<NormalizedMessageEvent> {
    const { protocol, groupId, messageType, messageScene } = this.extractContextFields(context);

    if (protocol !== 'milky') {
      throw new Error(`getMessageFromContext only supports Milky protocol | protocol=${protocol}`);
    }

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

    const queryCriteria: Partial<Message> = isGroup
      ? { protocol, groupId, messageSeq }
      : { protocol, messageSeq, messageType: 'private' };

    // Try cache first (no DB needed for cache hit without image segments)
    let cached: NormalizedMessageEvent | undefined;
    if (isGroup && groupId !== undefined) {
      const c = getCachedMessageBySeq(protocol, groupId, messageSeq, true);
      cached = c && c.groupId === groupId ? c : undefined;
    } else {
      const c = getCachedMessageBySeq(protocol, 0, messageSeq, false);
      cached = c && c.messageType === 'private' ? c : undefined;
    }

    if (cached) {
      const hasImageSegment = cached.segments?.some((s) => s.type === 'image');
      if (!hasImageSegment) {
        return cached;
      }
      // Cache hit with image segments may be bot card echo; prefer DB so referenced message shows cardText, not image.
    }

    // Need DB: resolve adapter once (for cache hit with image override, or cache miss)
    const adapter = databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      throw new Error(
        `Database not connected | messageSeq=${messageSeq} | protocol=${protocol} | ${isGroup ? `groupId=${groupId}` : 'private'}`,
      );
    }
    const messages = adapter.getModel('messages');

    if (cached) {
      try {
        const dbMessage = await messages.findOne(queryCriteria);
        const isBotReply =
          dbMessage?.metadata && typeof dbMessage.metadata === 'object' && dbMessage.metadata.isBotReply === true;
        if (dbMessage && isBotReply) {
          const normalized = this.buildNormalizedFromDbMessage(dbMessage, protocol, messageScene);
          cacheMessage(normalized);
          return normalized;
        }
      } catch {
        // Fall through to return cached
      }
      return cached;
    }

    // Cache miss: load from DB
    let dbMessage: Message | null = null;
    try {
      dbMessage = await messages.findOne(queryCriteria);
    } catch (error) {
      throw new Error(
        `Failed to query message from database | messageSeq=${messageSeq} | protocol=${protocol} | ${isGroup ? `groupId=${groupId}` : 'private'} | error=${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    if (dbMessage) {
      const normalizedMessage = this.buildNormalizedFromDbMessage(dbMessage, protocol, messageScene);
      cacheMessage(normalizedMessage);
      return normalizedMessage;
    }

    throw new Error(`Message not found | messageSeq=${messageSeq} | protocol=${protocol} | groupId=${groupId}`);
  }
}
