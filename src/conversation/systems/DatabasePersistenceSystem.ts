// Database Persistence System - saves messages and conversations to database

import { randomUUID } from 'node:crypto';
import { getReply, getReplyContent } from '@/context/HookContextHelpers';
import { normalizeSessionId } from '@/conversation/history';
import type { System } from '@/core/system';
import { SystemPriority, SystemStage } from '@/core/system';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { Message } from '@/database/models/types';
import type { HookContext } from '@/hooks/types';
import { cacheMessage } from '@/message/MessageCache';
import { logger } from '@/utils/logger';

/**
 * Database Persistence System
 * Saves messages and conversations to database after processing.
 * Executes in COMPLETE stage so that every reply path has already produced context.reply before we run.
 *
 * Guarantee (no loss, no duplicate):
 * - Pipeline reply paths (full lifecycle, reply-only): we persist the trigger user message + bot reply here
 *   (reply is persisted in the same run that sends it; send happens in MessagePipeline.handleReply after COMPLETE).
 * - Proactive reply path: does not go through this system; ProactiveConversationService calls
 *   ConversationHistoryService.appendBotReplyToGroup() after sending, so the reply is written to DB there.
 * - Bot's own message (echo): we skip persisting entirely so we never store the echo as a second record;
 *   the real reply was already stored in the run that sent it (or via appendBotReplyToGroup for proactive).
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
      const conversationId = conversation?.id || randomUUID();

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
      const reply = getReply(context);
      const replyContent = getReplyContent(context);

      // Skip this entire run when the *incoming* message is from the bot (echo). We do not persist the echo; the real reply was already stored in the run that handled the user message (below we persist user message + bot reply for that run).
      const botSelfId = context.metadata.get('botSelfId');
      const isFromBot =
        botSelfId != null &&
        message.userId != null &&
        String(message.userId) === String(botSelfId);
      if (isFromBot) {
        return true;
      }

      // Save *trigger* user message (the one that caused this run)
      // For Milky protocol, save all important fields to metadata
      const metadata: Record<string, unknown> = {
        sender: message.sender,
        timestamp: message.timestamp,
      };
      if (context.metadata.get('triggeredByAtBot') === true) {
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

      // Save bot reply for *this* run (only reached when message was from user; echo run already returned above).
      // reply comes from getReply(context): for card reply it is cardTextForHistory (card JSON text); for text reply it is extracted text.
      // Card text is stored in content so that when loading from DB we use message.content to get the card text (LLM-readable).
      // For card reply we omit rawContent to avoid storing the image; for non-card we keep rawContent (segments) when present.
      if (reply) {
        const botUserId = typeof botSelfId === 'string' ? parseInt(botSelfId, 10) : botSelfId || 0;
        const isCardReply = replyContent?.metadata?.isCardImage === true;
        await messages.create({
          conversationId: conversation.id,
          userId: botUserId,
          messageType: message.messageType,
          groupId: message.groupId,
          content: reply,
          rawContent:
            !isCardReply && replyContent?.segments?.length ? JSON.stringify(replyContent.segments) : undefined,
          protocol: message.protocol || 'unknown',
          metadata: {
            isBotReply: true,
            timestamp: now.toISOString(),
          },
        });
      }

      // Update conversation
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
