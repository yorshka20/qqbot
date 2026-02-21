// Database Persistence System - saves messages and conversations to database

import { getReply } from '@/context/HookContextHelpers';
import type { System } from '@/core/system';
import { SystemPriority, SystemStage } from '@/core/system';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { HookContext } from '@/hooks/types';
import { cacheMessage } from '@/message/MessageCache';
import { logger } from '@/utils/logger';
import { randomUUID } from 'node:crypto';

/**
 * Database Persistence System
 * Saves messages and conversations to database after processing
 * Executes in COMPLETE stage to ensure all data is saved
 * Also caches messages in memory for quick lookup
 */
export class DatabasePersistenceSystem implements System {
  readonly name = 'database-persistence';
  readonly version = '1.0.0';
  readonly stage = SystemStage.COMPLETE;
  readonly priority = SystemPriority.DatabasePersistence; // Lower priority, runs after other complete stage systems

  constructor(private databaseManager: DatabaseManager) { }

  enabled(): boolean {
    return true;
  }

  async execute(context: HookContext): Promise<boolean> {
    const messageId = context.message?.id || context.message?.messageId || 'unknown';
    const sessionId = context.metadata.get('sessionId');
    const sessionType = context.metadata.get('sessionType');

    if (!sessionId || !sessionType) {
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
        logger.debug(
          `[DatabasePersistenceSystem] Created conversation | conversationId=${conversationId} | sessionId=${sessionId}`,
        );
      }

      const messages = adapter.getModel('messages');
      const message = context.message;
      const reply = getReply(context);

      // Save user message
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

      const messageData: {
        conversationId: string;
        userId: number;
        messageType: 'private' | 'group';
        groupId?: number;
        content: string;
        rawContent?: string;
        protocol: string;
        messageId?: string;
        messageSeq?: number;
        metadata: Record<string, unknown>;
      } = {
        conversationId: conversation.id,
        userId: message.userId,
        messageType: message.messageType,
        groupId: message.groupId,
        content: message.message,
        rawContent: message.segments ? JSON.stringify(message.segments) : undefined,
        protocol: message.protocol || 'unknown',
        metadata,
      };

      // For Milky protocol, save messageSeq to dedicated column (not messageId)
      if (message.protocol === 'milky' && 'messageSeq' in message) {
        const milkyMessage = message as typeof message & { messageSeq?: number };
        const seq = milkyMessage.messageSeq;
        if (typeof seq === 'number' && !isNaN(seq)) {
          messageData.messageSeq = seq;
        }
      } else if (message.messageId !== undefined) {
        // For other protocols, save messageId if available
        messageData.messageId = message.messageId.toString();
      }

      await messages.create(messageData);

      logger.debug(
        `[DatabasePersistenceSystem] Saved user message | conversationId=${conversation.id} | messageId=${messageId}`,
      );

      // Cache message in memory for quick lookup (e.g., for reply segments)
      cacheMessage(message);

      // Save bot reply if exists
      if (reply) {
        const botSelfId = context.metadata.get('botSelfId');
        const botUserId = typeof botSelfId === 'string' ? parseInt(botSelfId, 10) : botSelfId || 0;
        await messages.create({
          conversationId: conversation.id,
          userId: botUserId,
          messageType: message.messageType,
          groupId: message.groupId,
          content: reply,
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
}
