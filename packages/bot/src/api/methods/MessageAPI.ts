// Message API method wrappers

import type { CommandContext } from '@/command/types';
import type { ProtocolName } from '@/core/config/types/protocol';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { Message } from '@/database/models/types';
import type { NormalizedMessageEvent, NormalizedNoticeEvent } from '@/events/types';
import { cacheMessage, getCachedMessageBySeq } from '@/message/MessageCache';
import type { MessageSegment } from '@/message/types';
import { getProtocolAdapter } from '@/protocol/ProtocolRegistry';
import { logger } from '@/utils/logger';
import type { APIClient } from '../APIClient';
import type { ForwardMessageInput, SendMessageResult, SendTarget } from '../types';

/** Maximum text length per message. Messages exceeding this are automatically split. */
const MAX_TEXT_LENGTH = 1500;

/** Delay between split message sends to avoid rate limiting (ms). */
const SPLIT_SEND_DELAY_MS = 300;

/** Context types supported by extractProtocol, recallFromContext, getMessageFromContext. */
export type MessageAPIContext = CommandContext | NormalizedMessageEvent | NormalizedNoticeEvent;

/** Extracted fields from MessageAPIContext for API calls. */
interface ExtractedContextFields {
  protocol: ProtocolName;
  userId?: number | string;
  groupId?: number | string;
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
   * Normalize message input to MessageSegment[].
   */
  private normalizeToSegments(message: string | unknown[]): MessageSegment[] {
    if (typeof message === 'string') {
      return [{ type: 'text', data: { text: message } }];
    }
    return message as MessageSegment[];
  }

  /**
   * Split text into chunks by line boundaries, ensuring each chunk <= maxLength characters.
   * Falls back to hard character split for single lines exceeding the limit.
   */
  private splitTextByLines(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    const lines = text.split('\n');
    let current = '';

    for (const line of lines) {
      const candidate = current ? `${current}\n${line}` : line;

      if (candidate.length > maxLength) {
        if (current) {
          chunks.push(current);
          current = '';
        }
        if (line.length > maxLength) {
          let remaining = line;
          while (remaining.length > maxLength) {
            chunks.push(remaining.substring(0, maxLength));
            remaining = remaining.substring(maxLength);
          }
          current = remaining;
        } else {
          current = line;
        }
      } else {
        current = candidate;
      }
    }

    if (current) chunks.push(current);
    return chunks;
  }

  /**
   * Split message segments into batches if total text content exceeds MAX_TEXT_LENGTH.
   * Non-text segments are included in the first batch only.
   */
  private splitLongMessage(segments: MessageSegment[]): MessageSegment[][] {
    let totalTextLength = 0;
    for (const seg of segments) {
      if (seg.type === 'text') totalTextLength += seg.data.text.length;
    }
    if (totalTextLength <= MAX_TEXT_LENGTH) return [segments];

    const nonTextSegments: MessageSegment[] = [];
    let allText = '';
    for (const seg of segments) {
      if (seg.type === 'text') {
        allText += seg.data.text;
      } else {
        nonTextSegments.push(seg);
      }
    }

    const textChunks = this.splitTextByLines(allText, MAX_TEXT_LENGTH);
    logger.debug(`[MessageAPI] Splitting long message (${totalTextLength} chars) into ${textChunks.length} parts`);

    return textChunks.map((chunk, i) => {
      const batch: MessageSegment[] = [];
      if (i === 0) batch.push(...nonTextSegments);
      batch.push({ type: 'text', data: { text: chunk } });
      return batch;
    });
  }

  /** Small delay between split message sends. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Normalize a chat id (user_id / group_id) before handing it to the protocol adapter.
   *
   * Milky/OneBot11 zod-validate these fields as `number` and will reject numeric strings,
   * while Discord/Satori stringify them anyway. Normalizing numeric strings to numbers
   * here satisfies both sides, so call sites can freely pass whatever shape they have
   * (config strings, wire payloads, already-numeric values) without sprinkling `Number(...)`.
   *
   * Non-numeric strings (e.g. Discord snowflakes that happen to include non-digits, or
   * future string-ID protocols) are returned as-is.
   */
  private normalizeChatId(id: number | string): number | string {
    if (typeof id === 'number') return id;
    return /^\d+$/.test(id) ? Number(id) : id;
  }

  /**
   * Send a private message directly by userId and protocol.
   * Use this when no message context is available (e.g. AgentLoop scheduled tasks).
   * When a CommandContext or NormalizedMessageEvent is available, prefer sendFromContext().
   */
  async sendPrivateMessage(
    userId: number | string,
    message: string | unknown[],
    protocol: ProtocolName,
  ): Promise<number> {
    const normalizedUserId = this.normalizeChatId(userId);
    const segments = this.normalizeToSegments(message);
    const batches = this.splitLongMessage(segments);

    let lastMessageId!: number;
    for (let i = 0; i < batches.length; i++) {
      if (i > 0) await this.delay(SPLIT_SEND_DELAY_MS);
      const result = await this.apiClient.call<SendMessageResult>(
        'send_private_msg',
        {
          user_id: normalizedUserId,
          message: batches[i],
        },
        protocol,
      );
      const messageId = result.message_seq ?? result.message_id;
      if (messageId === undefined) {
        throw new Error('API did not return a valid message ID');
      }
      lastMessageId = messageId;
    }
    return lastMessageId;
  }

  /**
   * Send a group message directly by groupId and protocol.
   * Use this when no message context is available (e.g. AgentLoop scheduled tasks).
   * When a CommandContext or NormalizedMessageEvent is available, prefer sendFromContext().
   */
  async sendGroupMessage(
    groupId: number | string,
    message: string | unknown[],
    protocol: ProtocolName,
  ): Promise<number> {
    const normalizedGroupId = this.normalizeChatId(groupId);
    const segments = this.normalizeToSegments(message);
    const batches = this.splitLongMessage(segments);

    let lastMessageId!: number;
    for (let i = 0; i < batches.length; i++) {
      if (i > 0) await this.delay(SPLIT_SEND_DELAY_MS);
      const result = await this.apiClient.call<SendMessageResult>(
        'send_group_msg',
        {
          group_id: normalizedGroupId,
          message: batches[i],
        },
        protocol,
      );
      const messageId = result.message_seq ?? result.message_id;
      if (messageId === undefined) {
        throw new Error('API did not return a valid message ID');
      }
      lastMessageId = messageId;
    }
    return lastMessageId;
  }

  /**
   * Extract SendTarget from a CommandContext or NormalizedMessageEvent.
   */
  private extractSendTarget(context: CommandContext | NormalizedMessageEvent): SendTarget {
    return {
      messageType: context.messageType,
      userId: context.userId,
      groupId: context.groupId,
      messageScene:
        'messageScene' in context && typeof context.messageScene === 'string' ? context.messageScene : undefined,
    };
  }

  /**
   * Send message from context (CommandContext or NormalizedMessageEvent).
   * Delegates to the protocol's registered sendMessage capability, which handles
   * segment conversion and delivery internally.
   */
  async sendFromContext(
    message: string | unknown[],
    context: CommandContext | NormalizedMessageEvent,
    timeout: number = 10000,
  ): Promise<SendMessageResult> {
    const protocol = this.extractProtocol(context);
    const adapter = getProtocolAdapter(protocol);
    const target = this.extractSendTarget(context);

    const segments = this.normalizeToSegments(message);
    const batches = this.splitLongMessage(segments);

    let lastResult!: SendMessageResult;
    for (let i = 0; i < batches.length; i++) {
      if (i > 0) await this.delay(SPLIT_SEND_DELAY_MS);
      lastResult = await adapter.sendMessage(batches[i], target, timeout);
    }
    return lastResult;
  }

  /**
   * Send a forward message directly by target type and id.
   * Use this when no CommandContext or NormalizedMessageEvent is available.
   */
  async sendForwardMessage(
    target: { type: 'user' | 'group'; id: number | string },
    messages: ForwardMessageInput[],
    protocol: ProtocolName,
    options: { botUserId: number | string },
    timeout: number = 10000,
  ): Promise<SendMessageResult> {
    const adapter = getProtocolAdapter(protocol);
    if (!adapter.supportsForwardMessage()) {
      throw new Error(`Forward message is not supported for protocol: ${protocol}`);
    }
    const sendTarget: SendTarget = {
      messageType: target.type === 'user' ? 'private' : 'group',
      ...(target.type === 'user' ? { userId: target.id } : { groupId: target.id }),
    };
    return adapter.sendForwardMessage(messages, sendTarget, options.botUserId, timeout);
  }

  /**
   * Send a forward message from context.
   * Delegates to the protocol adapter's sendForwardMessage method.
   */
  async sendForwardFromContext(
    messages: ForwardMessageInput[],
    context: CommandContext | NormalizedMessageEvent,
    timeout: number = 10000,
    options: { botUserId: number | string },
  ): Promise<SendMessageResult> {
    const protocol = this.extractProtocol(context);
    const adapter = getProtocolAdapter(protocol);
    if (!adapter.supportsForwardMessage()) {
      throw new Error(`Forward message is not supported for protocol: ${protocol}`);
    }
    const target = this.extractSendTarget(context);

    logger.debug(
      `[MessageAPI] sendForwardFromContext | group_id=${target.groupId} | nodes=${messages.length} | botUserId=${options.botUserId}`,
    );

    return adapter.sendForwardMessage(messages, target, options.botUserId, timeout);
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
   * Get HTTP download URL for a group file attachment by file_id (Milky only).
   * Chat file segments do not include temp_url; use get_group_file_download_url instead of get_resource_temp_url.
   */
  async getGroupFileDownloadUrl(
    fileId: string,
    context: CommandContext | NormalizedMessageEvent,
  ): Promise<string | null> {
    const protocol = this.extractProtocol(context);
    if (protocol !== 'milky') {
      return null;
    }
    const groupId = 'groupId' in context ? context.groupId : undefined;
    if (groupId === undefined || groupId === null || groupId === '') {
      return null;
    }
    const gid = typeof groupId === 'number' ? groupId : Number(groupId);
    if (Number.isNaN(gid)) {
      return null;
    }
    try {
      const response = await this.apiClient.call<{ download_url: string }>(
        'get_group_file_download_url',
        { group_id: gid, file_id: fileId },
        protocol,
        30000,
      );
      const url = response?.download_url;
      if (typeof url === 'string' && url && (url.startsWith('http://') || url.startsWith('https://'))) {
        logger.debug(`[MessageAPI] Got group file download URL for file_id=${fileId.substring(0, 24)}...`);
        return url;
      }
      return null;
    } catch (error) {
      logger.warn(
        `[MessageAPI] get_group_file_download_url failed | fileId=${fileId.substring(0, 30)}... | error=${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return null;
    }
  }

  /**
   * Get HTTP download URL for a private-chat file attachment (Milky only).
   * Requires file_hash from the file segment when temp_url is absent.
   */
  async getPrivateFileDownloadUrl(
    fileId: string,
    fileHash: string,
    context: CommandContext | NormalizedMessageEvent,
  ): Promise<string | null> {
    const protocol = this.extractProtocol(context);
    if (protocol !== 'milky') {
      return null;
    }
    const userId = 'userId' in context ? context.userId : undefined;
    if (userId === undefined || userId === null || userId === '') {
      return null;
    }
    const uid = typeof userId === 'number' ? userId : Number(userId);
    if (Number.isNaN(uid)) {
      return null;
    }
    try {
      const response = await this.apiClient.call<{ download_url: string }>(
        'get_private_file_download_url',
        { user_id: uid, file_id: fileId, file_hash: fileHash },
        protocol,
        30000,
      );
      const url = response?.download_url;
      if (typeof url === 'string' && url && (url.startsWith('http://') || url.startsWith('https://'))) {
        logger.debug(`[MessageAPI] Got private file download URL for file_id=${fileId.substring(0, 24)}...`);
        return url;
      }
      return null;
    } catch (error) {
      logger.warn(
        `[MessageAPI] get_private_file_download_url failed | fileId=${fileId.substring(0, 30)}... | error=${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return null;
    }
  }

  /**
   * Upload a file to a group or private chat via Milky protocol file upload API.
   * @param fileUri - File URI (file://, http(s)://, base64://)
   * @param fileName - Display name for the uploaded file
   * @param context - CommandContext or NormalizedMessageEvent to determine target
   * @param timeout - Upload timeout (default: 60000ms)
   * @returns file_id from the upload response
   */
  async uploadFile(
    fileUri: string,
    fileName: string,
    context: CommandContext | NormalizedMessageEvent,
    timeout = 60000,
  ): Promise<string> {
    const protocol = this.extractProtocol(context);

    if (context.messageType === 'group' && context.groupId) {
      const result = await this.apiClient.call<{ file_id: string }>(
        'upload_group_file',
        {
          group_id: context.groupId,
          parent_folder_id: '/',
          file_uri: fileUri,
          file_name: fileName,
        },
        protocol,
        timeout,
      );
      return result.file_id;
    }

    if (context.messageType === 'private') {
      const result = await this.apiClient.call<{ file_id: string }>(
        'upload_private_file',
        {
          user_id: context.userId,
          file_uri: fileUri,
          file_name: fileName,
        },
        protocol,
        timeout,
      );
      return result.file_id;
    }

    throw new Error('Unable to determine message type from context for file upload');
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

    // Cache + DB miss: try fetching from protocol server via adapter
    const peerId = isGroup ? groupId : undefined;
    if (peerId !== undefined) {
      const scene = isGroup ? (messageScene ?? 'group') : 'friend';
      const adapter = getProtocolAdapter(protocol);
      const apiMessage = await adapter.fetchMessage(messageSeq, peerId, scene);
      if (apiMessage) {
        cacheMessage(apiMessage);
        return apiMessage;
      }
    }

    throw new Error(`Message not found | messageSeq=${messageSeq} | protocol=${protocol} | groupId=${groupId}`);
  }
}
