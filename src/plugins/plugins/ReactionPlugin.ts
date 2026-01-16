// Reaction Plugin - sends reaction when message contains configured keywords

import type { NormalizedMessageEvent } from '@/events/types';
import type { HookContext, HookResult } from '@/hooks/types';
import type { NormalizedMilkyMessageEvent } from '@/protocol/milky/types';
import { logger } from '@/utils/logger';
import { Hook, Plugin } from '../decorators';
import { PluginBase } from '../PluginBase';

interface ReactionPluginConfig {
  /**
   * Map of keyword to reaction ID
   * Key: keyword (case-insensitive)
   * Value: reaction ID (emoji code like "76" for 👍, or emoji character like "👍" which will be converted to code)
   * Example: { "": "76", "hello": "👍" }
   */
  reactions?: Record<string, string>;
}

@Plugin({
  name: 'reaction',
  version: '1.0.0',
  description: 'Sends group message reaction when message contains configured keywords',
})
export class ReactionPlugin extends PluginBase {
  /**
   * Map of keyword (lowercase) to reaction ID (code)
   * Populated from config.reactions
   */
  private keywordToReactionMap: Map<string, string> = new Map();

  async onInit(): Promise<void> {
    // Load plugin-specific configuration
    try {
      const pluginConfig = this.pluginConfig?.config as ReactionPluginConfig | undefined;

      // Load keyword to reaction mappings
      this.keywordToReactionMap.clear();
      if (pluginConfig?.reactions && typeof pluginConfig.reactions === 'object') {
        for (const [keyword, reaction] of Object.entries(pluginConfig.reactions)) {
          const keywordLower = keyword.toLowerCase();
          this.keywordToReactionMap.set(keywordLower, reaction);
        }
      }
    } catch (error) {
      logger.error('[ReactionPlugin] Error loading config:', error);
      this.enabled = false;
    }
  }

  /**
   * Hook: onMessagePreprocess
   * Executed during PREPROCESS stage
   * Checks if message contains any configured keyword and sends corresponding reaction for whitelisted group messages (even without @bot)
   */
  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'NORMAL',
    order: 10,
  })
  onMessagePreprocess(context: HookContext): HookResult {
    if (!this.enabled) {
      return true;
    }

    const messageId = context.message?.id || context.message?.messageId || 'unknown';

    if (this.keywordToReactionMap.size === 0) {
      return true;
    }

    // Ignore bot's own messages
    const botSelfId = context.metadata.get('botSelfId');
    const messageUserId = context.message.userId?.toString();
    if (botSelfId && messageUserId && botSelfId === messageUserId) {
      return true;
    }

    // Only process group messages
    if (context.message.messageType !== 'group' || !context.message.groupId) {
      return true;
    }

    // Only send reaction in whitelisted groups
    const isWhitelistGroup = context.metadata.get('whitelistGroup');
    if (!isWhitelistGroup) {
      return true;
    }

    // Check if message contains any configured keyword (case-insensitive)
    const messageText = context.message.message.toLowerCase();
    let matchedKeyword: string | undefined;
    let matchedReaction: string | undefined;

    for (const [keyword, reaction] of this.keywordToReactionMap.entries()) {
      if (messageText.includes(keyword)) {
        matchedKeyword = keyword;
        matchedReaction = reaction;
        break;
      }
    }

    if (!matchedKeyword || !matchedReaction) {
      return true;
    }

    logger.info(
      `[ReactionPlugin] Keyword "${matchedKeyword}" detected in whitelisted group | messageId=${messageId} | groupId=${context.message.groupId} | reaction=${matchedReaction}`,
    );

    // Send reaction asynchronously (don't block message processing)
    this.sendReaction(context, matchedReaction).catch((error) => {
      logger.error(`[ReactionPlugin] Failed to send reaction | messageId=${messageId}:`, error);
    });

    return true;
  }

  /**
   * Type guard to check if message is from Milky protocol
   */
  private isMilkyMessage(message: NormalizedMessageEvent): message is NormalizedMilkyMessageEvent {
    return 'messageSeq' in message && typeof (message as NormalizedMilkyMessageEvent).messageSeq === 'number';
  }

  /**
   * Send reaction to the message
   * @param context Hook context containing message information
   * @param reactionId Reaction ID (emoji code) to send
   */
  private async sendReaction(context: HookContext, reactionId: string): Promise<void> {
    if (!this.context) {
      logger.error('[ReactionPlugin] Plugin context not available');
      return;
    }

    const groupId = context.message.groupId;

    if (!groupId) {
      logger.warn('[ReactionPlugin] Missing groupId, cannot send reaction');
      return;
    }

    // For Milky protocol, we need message_seq (number) instead of message_id
    // Check if message is from Milky protocol and has messageSeq
    let messageSeq: number | undefined;

    if (this.isMilkyMessage(context.message)) {
      messageSeq = context.message.messageSeq;
    }

    if (!messageSeq) {
      logger.warn(
        `[ReactionPlugin] Missing messageSeq (required for Milky protocol), cannot send reaction | messageId=${context.message?.id || context.message?.messageId || 'unknown'}`,
      );
      return;
    }

    try {
      logger.debug(
        `[ReactionPlugin] Sending reaction | groupId=${groupId} | messageSeq=${messageSeq} | reaction=${reactionId}`,
      );

      await this.api.call(
        'send_group_message_reaction',
        {
          group_id: groupId,
          message_seq: messageSeq,
          reaction: reactionId,
          is_add: true,
        },
        'milky',
      );

      logger.info(
        `[ReactionPlugin] Reaction sent successfully | messageSeq=${messageSeq} | groupId=${groupId} | reaction=${reactionId}`,
      );
    } catch (error) {
      logger.error(`[ReactionPlugin] Error sending reaction | messageSeq=${messageSeq} | groupId=${groupId}:`, error);
      // Don't throw - just log the error, don't interrupt message processing
    }
  }
}
