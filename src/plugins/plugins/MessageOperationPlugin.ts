// MessageOperation Plugin - handles reactions on messages and triggers operations

import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationManager } from '@/conversation/ConversationManager';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { NormalizedNoticeEvent } from '@/events/types';
import { logger } from '@/utils/logger';
import { RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

interface MessageOperationPluginConfig {
  /**
   * Map of reaction ID to operation
   * Key: reaction ID (string)
   * Value: operation type ('recall' for message recall, 'reply' for bot reply to that message)
   * Example: { "38": "recall", "1": "reply" }
   */
  reactionOperations?: Record<string, string>;
}

@RegisterPlugin({
  name: 'messageOperation',
  version: '1.0.0',
  description: 'Handles reactions on messages and triggers operations (recall, reply to message)',
})
export class MessageOperationPlugin extends PluginBase {
  /**
   * Map of reaction ID to operation type
   * Populated from config.reactionOperations
   */
  private reactionToOperationMap: Map<string, string> = new Map();

  private messageAPI!: MessageAPI;
  private databaseManager!: DatabaseManager;
  private conversationManager!: ConversationManager;

  async onInit(): Promise<void> {
    const container = getContainer();
    if (!container.isRegistered(DITokens.MESSAGE_API)) {
      throw new Error('[MessageOperationPlugin] MESSAGE_API not registered in DI container');
    }
    if (!container.isRegistered(DITokens.DATABASE_MANAGER)) {
      throw new Error('[MessageOperationPlugin] DATABASE_MANAGER not registered in DI container');
    }
    if (!container.isRegistered(DITokens.CONVERSATION_MANAGER)) {
      throw new Error('[MessageOperationPlugin] CONVERSATION_MANAGER not registered in DI container');
    }
    this.messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);
    this.databaseManager = container.resolve<DatabaseManager>(DITokens.DATABASE_MANAGER);
    this.conversationManager = container.resolve<ConversationManager>(DITokens.CONVERSATION_MANAGER);

    // Load plugin-specific configuration
    try {
      const pluginConfig = this.pluginConfig?.config as MessageOperationPluginConfig | undefined;

      // Load reaction to operation mappings
      this.reactionToOperationMap.clear();
      if (pluginConfig?.reactionOperations && typeof pluginConfig.reactionOperations === 'object') {
        for (const [reactionId, operation] of Object.entries(pluginConfig.reactionOperations)) {
          this.reactionToOperationMap.set(reactionId, operation);
        }
      }
    } catch (error) {
      logger.error('[MessageOperationPlugin] Error loading config:', error);
      this.enabled = false;
    }

    // Register notice event handler for reaction events
    this.on('notice', this.handleNotice.bind(this));
  }

  /**
   * Handle notice events, specifically group message reactions
   */
  private async handleNotice(event: NormalizedNoticeEvent): Promise<void> {
    if (!this.enabled) {
      return;
    }

    // Only handle group message reaction notices
    if (event.noticeType !== 'group_message_reaction') {
      return;
    }

    logger.debug('[MessageOperationPlugin] Received group message reaction notice:', event);

    const reactionId = event.faceId?.toString();
    const messageSeq = event.messageSeq ?? 0;
    const groupId = event.groupId ?? 0;
    const userId = event.userId ?? 0;
    const isAdd = event.isAdd;

    if (!reactionId || !messageSeq || !groupId || !userId) {
      logger.warn('[MessageOperationPlugin] Missing required fields in reaction notice');
      return;
    }

    // Only process reactions that are being added (not removed)
    if (!isAdd) {
      return;
    }

    // Check if this reaction has a configured operation
    const operation = this.reactionToOperationMap.get(reactionId);
    if (!operation) {
      return;
    }

    logger.info(
      `[MessageOperationPlugin] Reaction ${reactionId} detected on message ${messageSeq} in group ${groupId} by user ${userId}, triggering operation: ${operation}`,
    );

    // Execute the operation
    try {
      await this.executeOperation(operation, {
        reactionId,
        messageSeq,
        groupId,
        userId,
        noticeEvent: event,
      });
    } catch (error) {
      logger.error(`[MessageOperationPlugin] Error executing operation ${operation}:`, error);
    }
  }

  /**
   * Execute the configured operation
   */
  private async executeOperation(
    operation: string,
    context: {
      reactionId: string;
      messageSeq: number;
      groupId: number;
      userId: number;
      noticeEvent: NormalizedNoticeEvent;
    },
  ): Promise<void> {
    switch (operation) {
      case 'recall':
        await this.recallMessage(context);
        break;
      case 'reply':
        await this.replyMessage(context);
        break;
      default:
        logger.warn(`[MessageOperationPlugin] Unknown operation: ${operation}`);
    }
  }

  /**
   * Recall a message that received the configured reaction.
   * Context (protocol, groupId, messageType) comes from the normalized notice event (upstream MilkyEventNormalizer).
   * Note: Bot can only recall its own messages. If the message is not sent by the bot,
   * the recall operation will fail silently.
   */
  private async recallMessage(context: {
    reactionId: string;
    messageSeq: number;
    groupId: number;
    userId: number;
    noticeEvent: NormalizedNoticeEvent;
  }): Promise<void> {
    if (!this.context || !this.messageAPI) {
      logger.error('[MessageOperationPlugin] Plugin context or MessageAPI not available');
      return;
    }

    const { messageSeq, groupId, userId } = context;
    const notice = context.noticeEvent;

    try {
      logger.debug(
        `[MessageOperationPlugin] Attempting to recall message | groupId=${groupId} | messageSeq=${messageSeq} | reactionUser=${userId}`,
      );

      await this.messageAPI.recallFromContext(messageSeq, notice);

      logger.info(
        `[MessageOperationPlugin] Message recalled successfully | messageSeq=${messageSeq} | groupId=${groupId} | reactionUser=${userId}`,
      );
    } catch (error) {
      // Bot can only recall its own messages. If recall fails, it's likely because
      // the message was not sent by the bot, which is expected behavior.
      logger.debug(
        `[MessageOperationPlugin] Failed to recall message (likely not bot's message) | messageSeq=${messageSeq} | groupId=${groupId} | error=${(error as Error).message}`,
      );
    }
  }

  /**
   * Reply operation: treat the reacted message as "said to the bot" and run it through the pipeline.
   */
  private async replyMessage(context: {
    reactionId: string;
    messageSeq: number;
    groupId: number;
    userId: number;
    noticeEvent: NormalizedNoticeEvent;
  }): Promise<void> {
    if (!this.context || !this.messageAPI || !this.conversationManager) {
      logger.error('[MessageOperationPlugin] Plugin context or required services not available');
      return;
    }

    if (!this.databaseManager.getAdapter()?.isConnected()) {
      logger.warn('[MessageOperationPlugin] Database not available, cannot fetch message for reply operation');
      return;
    }

    const { messageSeq, groupId, noticeEvent } = context;

    try {
      const targetMessage = await this.messageAPI.getMessageFromContext(messageSeq, noticeEvent, this.databaseManager);

      logger.info(
        `[MessageOperationPlugin] Reply to message (reaction trigger) | messageSeq=${messageSeq} | groupId=${groupId}`,
      );
      await this.conversationManager.replyToMessage(targetMessage);
    } catch (error) {
      logger.error(
        `[MessageOperationPlugin] Reply operation failed | messageSeq=${messageSeq} | groupId=${groupId} | error=${(error as Error).message}`,
      );
    }
  }
}
