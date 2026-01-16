// MessageOperation Plugin - handles reactions on messages and triggers operations

import type { NormalizedNoticeEvent } from '@/events/types';
import { logger } from '@/utils/logger';
import { Plugin } from '../decorators';
import { PluginBase } from '../PluginBase';

interface MessageOperationPluginConfig {
  /**
   * Map of reaction ID to operation
   * Key: reaction ID (string)
   * Value: operation type ('recall' for message recall, etc.)
   * Example: { "38": "recall" }
   */
  reactionOperations?: Record<string, string>;
}

@Plugin({
  name: 'messageOperation',
  version: '1.0.0',
  description: 'Handles reactions on messages and triggers operations like message recall',
})
export class MessageOperationPlugin extends PluginBase {
  /**
   * Map of reaction ID to operation type
   * Populated from config.reactionOperations
   */
  private reactionToOperationMap: Map<string, string> = new Map();

  async onInit(): Promise<void> {
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

    // Extract reaction data from the notice event
    const reactionData = event as any; // Type assertion since we know it's a group_message_reaction

    // In Milky protocol, the field is 'face_id' not 'reaction_id'
    const reactionId = reactionData.face_id?.toString();
    const messageSeq = reactionData.message_seq;
    const groupId = reactionData.group_id;
    const userId = reactionData.user_id;
    const isAdd = reactionData.is_add;

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
      default:
        logger.warn(`[MessageOperationPlugin] Unknown operation: ${operation}`);
    }
  }

  /**
   * Recall a message that received the configured reaction
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
    if (!this.context) {
      logger.error('[MessageOperationPlugin] Plugin context not available');
      return;
    }

    const { messageSeq, groupId, userId } = context;

    try {
      logger.debug(
        `[MessageOperationPlugin] Attempting to recall message | groupId=${groupId} | messageSeq=${messageSeq} | reactionUser=${userId}`,
      );

      await this.api.call(
        'recall_group_message',
        {
          group_id: groupId,
          message_seq: messageSeq,
        },
        'milky',
      );

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
}
