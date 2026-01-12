// Database Persistence System - saves messages and conversations to database

import type { System } from '@/core/system';
import { SystemStage } from '@/core/system';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { randomUUID } from 'node:crypto';

/**
 * Database Persistence System
 * Saves messages and conversations to database after processing
 * Executes in COMPLETE stage to ensure all data is saved
 */
export class DatabasePersistenceSystem implements System {
  readonly name = 'database-persistence';
  readonly version = '1.0.0';
  readonly stage = SystemStage.COMPLETE;
  readonly priority = 10; // Lower priority, runs after other complete stage systems

  constructor(private databaseManager: DatabaseManager) {}

  async execute(context: HookContext): Promise<boolean> {
    const messageId = context.message?.id || context.message?.messageId || 'unknown';
    const sessionId = context.metadata.get('sessionId') as string;
    const sessionType = context.metadata.get('sessionType') as 'user' | 'group';

    if (!sessionId || !sessionType) {
      logger.debug('[DatabasePersistenceSystem] Missing sessionId or sessionType, skipping save');
      return true;
    }

    try {
      const adapter = this.databaseManager.getAdapter();
      if (!adapter || !adapter.isConnected()) {
        logger.debug('[DatabasePersistenceSystem] Database not connected, skipping save');
        return true;
      }

      // Get or create conversation
      const conversations = adapter.getModel('conversations');
      let conversation = await conversations.findOne({
        sessionId,
        sessionType,
      });

      const now = new Date();
      const conversationId = conversation?.id || randomUUID();

      if (!conversation) {
        // Create new conversation
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

      // Save message
      const messages = adapter.getModel('messages');
      const message = context.message;
      const reply = context.metadata.get('reply') as string;

      // Save user message
      await messages.create({
        conversationId: conversation.id,
        userId: message.userId,
        messageType: message.messageType,
        groupId: message.groupId,
        content: message.message,
        rawContent: message.segments ? JSON.stringify(message.segments) : undefined,
        protocol: message.protocol || 'unknown',
        messageId: message.messageId?.toString(),
        metadata: {
          sender: message.sender,
          timestamp: message.timestamp,
        },
      });

      logger.debug(
        `[DatabasePersistenceSystem] Saved user message | conversationId=${conversation.id} | messageId=${messageId}`,
      );

      // Save bot reply if exists
      if (reply) {
        const botSelfId = context.metadata.get('botSelfId') as string | number;
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

        logger.debug(`[DatabasePersistenceSystem] Saved bot reply | conversationId=${conversation.id}`);
      }

      // Update conversation
      const messageCount = await messages.count({ conversationId: conversation.id });
      await conversations.update(conversation.id, {
        messageCount,
        lastMessageAt: now,
      });

      logger.debug(
        `[DatabasePersistenceSystem] Updated conversation | conversationId=${conversation.id} | messageCount=${messageCount}`,
      );

      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[DatabasePersistenceSystem] Failed to save to database:', err);
      // Don't fail the lifecycle if database save fails
      return true;
    }
  }
}
