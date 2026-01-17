// AutoRecallPlugin - automatically recalls messages with images in private/temp chats

import { hasImages } from '@/ai/utils/imageUtils';
import { MessageAPI } from '@/api/methods/MessageAPI';
import { getReplyContent } from '@/context/HookContextHelpers';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { Hook, Plugin } from '../decorators';
import { PluginBase } from '../PluginBase';

interface AutoRecallPluginConfig {
  recallDelay?: number; // Delay in milliseconds before recalling (default: 60000 = 1 minute)
}

@Plugin({
  name: 'autoRecall',
  version: '1.0.0',
  description: 'Automatically recalls messages with images in private/temp chats',
})
export class AutoRecallPlugin extends PluginBase {
  // Store active recall timers to allow cleanup if plugin is disabled
  private recallTimers = new Map<string, NodeJS.Timeout>();
  private messageAPI!: MessageAPI;
  private recallDelay: number = 60000; // Default: 1 minute

  async onInit(): Promise<void> {
    // Cleanup any existing timers when plugin is initialized
    this.recallTimers.clear();
    // Initialize MessageAPI instance
    this.messageAPI = new MessageAPI(this.api);
    // Load configuration
    const config = (this.pluginConfig?.config || {}) as AutoRecallPluginConfig;
    this.recallDelay = config.recallDelay ?? 60000; // Default: 1 minute
  }

  async onDisable(): Promise<void> {
    // Clear all active recall timers when plugin is disabled
    for (const timer of this.recallTimers.values()) {
      clearTimeout(timer);
    }
    this.recallTimers.clear();
    await super.onDisable();
  }

  /**
   * Check if message contains images
   * Checks message segments in the reply
   */
  private messageHasImage(context: HookContext): boolean {
    const replyContent = getReplyContent(context);
    if (!replyContent?.segments || !Array.isArray(replyContent.segments)) {
      return false;
    }
    return hasImages(replyContent.segments);
  }

  /**
   * Check if message should be auto-recalled
   * Conditions:
   * 1. Message is in private chat or temporary session
   * 2. Message contains images
   * 3. Message is sent by bot
   */
  private shouldAutoRecall(context: HookContext): boolean {
    if (!this.enabled) {
      return false;
    }

    const messageType = context.message.messageType;
    const messageScene = context.message.messageScene;

    // Only trigger for private chats or temporary sessions
    if (messageType !== 'private' && messageScene !== 'temp') {
      return false;
    }

    // Check if message contains images
    return this.messageHasImage(context);
  }

  /**
   * Recall a message after delay
   */
  private async recallMessage(messageId: number, context: HookContext): Promise<void> {
    if (!this.context || !this.messageAPI) {
      logger.error('[AutoRecallPlugin] Plugin context or MessageAPI not available');
      return;
    }

    try {
      // Use MessageAPI to recall message, which automatically extracts protocol from context
      await this.messageAPI.recallFromContext(messageId, context.message);
      logger.info(
        `[AutoRecallPlugin] Message recalled successfully | messageId=${messageId} | userId=${context.message.userId}`,
      );
    } catch (error) {
      // Bot can only recall its own messages. If recall fails, log but don't throw
      logger.debug(
        `[AutoRecallPlugin] Failed to recall message | messageId=${messageId} | userId=${context.message.userId} | error=${(error as Error).message}`,
      );
    }
  }

  /**
   * Hook: onMessageSent
   * Check if message should be auto-recalled and schedule recall after configured delay
   */
  @Hook({
    stage: 'onMessageSent',
    priority: 'NORMAL',
    order: 0,
  })
  async onMessageSent(context: HookContext): Promise<boolean> {
    if (!this.shouldAutoRecall(context)) {
      return true;
    }

    // sentMessageResponse is available in onMessageSent hook after message is sent
    if (!context.sentMessageResponse) {
      return true;
    }

    // Extract message ID from response (Milky protocol uses message_seq, others use message_id)
    const sentMessageId = context.sentMessageResponse.message_seq ?? context.sentMessageResponse.message_id;
    if (!sentMessageId) {
      return true;
    }

    const userId = context.message.userId;
    const messageType = context.message.messageType;

    // Create unique timer key for cleanup
    const timerKey = `${userId}-${sentMessageId}`;

    // Schedule recall after configured delay
    const timer = setTimeout(() => {
      this.recallMessage(sentMessageId, context).catch((error) => {
        logger.error(`[AutoRecallPlugin] Error in recall timer: ${error}`);
      });
      this.recallTimers.delete(timerKey);
    }, this.recallDelay);

    this.recallTimers.set(timerKey, timer);

    logger.info(
      `[AutoRecallPlugin] Scheduled auto-recall for message | messageId=${sentMessageId} | userId=${userId} | messageType=${messageType} | delay=${this.recallDelay}ms`,
    );

    return true;
  }
}
