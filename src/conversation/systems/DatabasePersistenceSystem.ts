// Database Persistence System - saves messages and conversations to database

import { getReply, getReplyContent } from '@/context/HookContextHelpers';
import { normalizeSessionId } from '@/conversation/history';
import type { System, SystemContext } from '@/core/system';
import { SystemPriority, SystemStage } from '@/core/system';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { Message } from '@/database/models/types';
import { getHookPriority } from '@/hooks/HookPriority';
import type { HookContext } from '@/hooks/types';
import { cacheMessage } from '@/message/MessageCache';
import { logger } from '@/utils/logger';

/**
 * Database Persistence System
 * Saves messages and conversations to database after processing.
 * Executes in COMPLETE stage so that every reply path has already produced context.reply before we run.
 *
 * Guarantee (no loss, no duplicate):
 * - Pipeline reply paths: we persist the trigger user message here (COMPLETE). Bot reply is persisted in
 *   onMessageSent after send, so message_seq is available and no context metadata is needed.
 * - Proactive reply path: does not go through this system; ProactiveConversationService calls
 *   ConversationHistoryService.appendBotReplyToGroup() after sending, so the reply is written to DB there.
 * - Bot's own message (echo): we skip persisting entirely so we never store the echo as a second record;
 *   the real reply was already stored in onMessageSent (or via appendBotReplyToGroup for proactive).
 */
export class DatabasePersistenceSystem implements System {
  readonly name = 'database-persistence';
  readonly version = '1.0.0';
  readonly stage = SystemStage.COMPLETE;
  readonly priority = SystemPriority.DatabasePersistence; // Lower priority, runs after other complete stage systems

  constructor(private databaseManager: DatabaseManager) {}

  enabled(): boolean {
    return true;
  }

  initialize?(context: SystemContext): void {
    context.hookManager.addHandler(
      'onMessageSent',
      this.handleMessageSent.bind(this),
      getHookPriority('onMessageSent', 'NORMAL'),
    );
  }

  /**
   * Persist bot reply after send. We have the send API result here (sentMessageResponse);
   * for Milky, the adapter returns the server's response data as-is, so message_seq is present when the server returns it.
   * Optional in type only because SendMessageResult is shared with other protocols (e.g. OneBot uses message_id).
   * Only log error when protocol is Milky and message_seq is missing (Milky send response should include it).
   */
  private async handleMessageSent(context: HookContext): Promise<boolean> {
    // Reply content and send result: onMessageSent runs right after MessagePipeline.sendMessage(), so sentMessageResponse is set
    const reply = getReply(context);
    const replyContent = getReplyContent(context);
    const messageSeq = context.sentMessageResponse?.message_seq;

    if (!reply) {
      return true;
    }

    // message_seq is required for reply lookup (e.g. user quotes this bot message later). Milky send response should include it
    const hasValidMessageSeq = typeof messageSeq === 'number' && !Number.isNaN(messageSeq);
    if (!hasValidMessageSeq && context.message.protocol === 'milky') {
      logger.error(
        '[DatabasePersistenceSystem] Milky send response missing message_seq; bot reply cannot be found by reply lookup',
      );
    }

    try {
      const adapter = this.databaseManager.getAdapter();
      if (!adapter?.isConnected()) {
        return true;
      }

      // Resolve session and conversation (same rules as execute(); reply-only path may create conversation here)
      const rawSessionId = context.metadata.get('sessionId');
      const sessionType = context.metadata.get('sessionType') as 'group' | 'user' | undefined;
      if (!sessionType) {
        return true;
      }
      const sessionId = normalizeSessionId(
        rawSessionId,
        sessionType,
        context.metadata.get('groupId'),
        context.metadata.get('userId'),
      );
      if (!sessionId || sessionId.startsWith('unknown:')) {
        return true;
      }

      const conversations = adapter.getModel('conversations');
      let conversation = await conversations.findOne({ sessionId, sessionType });
      const now = new Date();
      if (!conversation) {
        conversation = await conversations.create({
          sessionId,
          sessionType,
          messageCount: 0,
          lastMessageAt: now,
          metadata: {},
        });
      }

      // Insert bot reply row: content from context.reply, message_seq from send API so later reply lookup can find it
      const messages = adapter.getModel('messages');
      const message = context.message;
      const botSelfId = context.metadata.get('botSelfId');
      const botUserId = typeof botSelfId === 'string' ? parseInt(botSelfId, 10) : botSelfId || 0;
      const isCardReply = replyContent?.metadata?.isCardImage === true;
      const botReplyData: Omit<Message, 'id' | 'createdAt' | 'updatedAt'> = {
        conversationId: conversation.id,
        userId: botUserId,
        messageType: message.messageType,
        groupId: message.groupId,
        content: reply,
        rawContent: !isCardReply && replyContent?.segments?.length ? JSON.stringify(replyContent.segments) : undefined,
        protocol: message.protocol || 'unknown',
        messageSeq,
        metadata: { isBotReply: true, timestamp: now.toISOString() },
      };
      await messages.create({
        ...botReplyData,
        createdAt: now,
        updatedAt: now,
      });

      // Bump conversation message count and lastMessageAt
      const messageCount = await messages.count({ conversationId: conversation.id });
      await conversations.update(conversation.id, { messageCount, lastMessageAt: now });
      logger.debug(
        `[DatabasePersistenceSystem] Persisted bot reply after send | messageSeq=${hasValidMessageSeq ? messageSeq : 'N/A'} | conversationId=${conversation.id}`,
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn(`[DatabasePersistenceSystem] Failed to persist bot reply in onMessageSent: ${err.message}`);
    }
    return true;
  }

  async execute(context: HookContext): Promise<boolean> {
    const rawSessionId = context.metadata.get('sessionId');
    const sessionType = (context.metadata.get('sessionType') as 'group' | 'user') ?? 'group';
    if (!sessionType) {
      return true;
    }
    const sessionId = normalizeSessionId(
      rawSessionId,
      sessionType,
      context.metadata.get('groupId'),
      context.metadata.get('userId'),
    );
    if (!sessionId || sessionId.startsWith('unknown:')) {
      return true;
    }

    try {
      const adapter = this.databaseManager.getAdapter();
      if (!adapter || !adapter.isConnected()) {
        return true;
      }

      const conversations = adapter.getModel('conversations');
      let conversation = await conversations.findOne({
        sessionId,
        sessionType,
      });

      const now = new Date();

      if (!conversation) {
        conversation = await conversations.create({
          sessionId,
          sessionType,
          messageCount: 0,
          lastMessageAt: now,
          metadata: {},
        });
      }

      const messages = adapter.getModel('messages');
      const message = context.message;

      // Skip this entire run when the *incoming* message is from the bot (echo). We do not persist the echo; the real reply was already stored in the run that handled the user message (below we persist user message + bot reply for that run).
      const botSelfId = context.metadata.get('botSelfId');
      const isFromBot = botSelfId != null && message.userId != null && String(message.userId) === String(botSelfId);
      if (isFromBot) {
        return true;
      }

      // Save *trigger* user message (the one that caused this run)
      // For Milky protocol, save all important fields to metadata
      const metadata: Record<string, unknown> = {
        sender: message.sender,
        timestamp: message.timestamp,
      };
      const triggerType = context.metadata.get('replyTriggerType');
      if (triggerType === 'at' || triggerType === 'reaction') {
        metadata.wasAtBot = true;
      }

      // Save Milky-specific fields
      if (message.protocol === 'milky') {
        const milkyMessage = message as typeof message & {
          messageSeq?: number;
          messageScene?: string;
          groupName?: string;
        };
        if (milkyMessage.messageScene !== undefined) {
          metadata.messageScene = milkyMessage.messageScene;
        }
        if (milkyMessage.groupName !== undefined) {
          metadata.groupName = milkyMessage.groupName;
        }
      }

      // Always persist segments when we have content so that reply-target messages can be restored with image segments
      const userMessageContent = message.message ?? '';
      const segmentsToSave = message.segments?.length
        ? message.segments
        : userMessageContent
          ? [{ type: 'text', data: { text: userMessageContent } }]
          : undefined;
      const messageData: Omit<Message, 'id' | 'createdAt' | 'updatedAt'> = {
        conversationId: conversation.id,
        userId: message.userId,
        messageType: message.messageType,
        groupId: message.groupId,
        content: userMessageContent,
        rawContent: segmentsToSave ? JSON.stringify(segmentsToSave) : undefined,
        protocol: message.protocol || 'unknown',
        metadata,
      };

      // For Milky protocol, save messageSeq to dedicated column (not messageId)
      if (message.protocol === 'milky' && 'messageSeq' in message) {
        const milkyMessage = message as typeof message & { messageSeq?: number };
        const seq = milkyMessage.messageSeq;
        if (typeof seq === 'number' && !Number.isNaN(seq)) {
          messageData.messageSeq = seq;
        }
      } else if (message.messageId !== undefined) {
        // For other protocols, save messageId if available
        messageData.messageId = message.messageId.toString();
      }

      // Use message event time for createdAt so DB reflects when the user sent the message (not server insert time).
      // Normalize: protocol may send seconds (e.g. Milky) or ms; store as Date, adapter writes UTC ISO.
      const userMessageTime = this.messageTimestampToDate(message.timestamp);
      await messages.create({
        ...messageData,
        createdAt: userMessageTime,
        updatedAt: userMessageTime,
      });

      // Cache message in memory for quick lookup (e.g., for reply segments)
      cacheMessage(message);

      // Bot reply is persisted in onMessageSent (after send) so message_seq is available; no persistence here.

      // Update conversation (user message only; bot reply will bump count in onMessageSent)
      const messageCount = await messages.count({ conversationId: conversation.id });
      await conversations.update(conversation.id, {
        messageCount,
        lastMessageAt: now,
      });

      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[DatabasePersistenceSystem] Failed to save to database:', err);
      return true;
    }
  }

  /**
   * Message event timestamp is always in ms (normalized at protocol layer).
   */
  private messageTimestampToDate(timestamp: number | undefined): Date {
    const raw = timestamp ?? Date.now();
    if (typeof raw !== 'number' || Number.isNaN(raw)) {
      return new Date();
    }
    return new Date(raw);
  }
}
