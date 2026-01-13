// Reaction Plugin - sends reaction when message contains configured keywords

import type { BotConfig } from '@/core/config';
import type { NormalizedMessageEvent } from '@/events/types';
import type { HookContext, HookResult } from '@/hooks/types';
import type { NormalizedMilkyMessageEvent } from '@/protocol/milky/types';
import { logger } from '@/utils/logger';
import { Hook, Plugin } from '../decorators';
import { PluginBase } from '../PluginBase';
import type { PluginContext } from '../types';

interface ReactionPluginConfig {
  enabled?: boolean;
  /**
   * Map of keyword to reaction ID
   * Key: keyword (case-insensitive)
   * Value: reaction ID (emoji code like "76" for 👍, or emoji character like "👍" which will be converted to code)
   * Example: { "cygnus": "76", "hello": "👍" }
   */
  reactions?: Record<string, string>;
}

@Plugin({
  name: 'reaction',
  version: '2.0.0',
  description: 'Sends group message reaction when message contains configured keywords',
})
export class ReactionPlugin extends PluginBase {
  readonly name = 'reaction';
  readonly version = '2.0.0';
  readonly description = 'Sends group message reaction when message contains configured keywords';

  private enabled: boolean = false;
  /**
   * Map of keyword (lowercase) to reaction ID (code)
   * Populated from config.reactions
   */
  private keywordToReactionMap: Map<string, string> = new Map();

  async onInit(context: PluginContext): Promise<void> {
    this.context = context;
    this.loadConfig();
  }

  /**
   * Load plugin configuration from bot config
   */
  private loadConfig(): void {
    try {
      const config = this.context?.bot.getConfig() as BotConfig;
      if (!config) {
        logger.warn('[CygnusReactionPlugin] Failed to load config');
        this.enabled = false;
        return;
      }

      // Get plugin-specific config from config.plugins.list
      const pluginEntry = config.plugins.list.find((p) => p.name === this.name);

      if (!pluginEntry) {
        logger.warn(`[CygnusReactionPlugin] No plugin entry found in config.plugins.list for plugin: ${this.name}`);
        this.enabled = false;
        return;
      }

      const pluginConfig = pluginEntry.config as ReactionPluginConfig | undefined;

      // Plugin enabled state is determined by pluginEntry.enabled, not pluginConfig.enabled
      this.enabled = pluginEntry.enabled && pluginConfig?.enabled !== false;

      // Load keyword to reaction mappings
      this.keywordToReactionMap.clear();
      if (pluginConfig?.reactions && typeof pluginConfig.reactions === 'object') {
        for (const [keyword, reaction] of Object.entries(pluginConfig.reactions)) {
          const keywordLower = keyword.toLowerCase();
          this.keywordToReactionMap.set(keywordLower, reaction);
          logger.debug(`[ReactionPlugin] Configured reaction mapping: "${keyword}" -> "${reaction}"`);
        }
      }

      if (this.keywordToReactionMap.size === 0) {
        logger.warn(`[ReactionPlugin] No reaction mappings configured. Plugin will not send any reactions.`);
      } else {
        logger.info(
          `[ReactionPlugin] Plugin ${this.enabled ? 'enabled' : 'disabled'} | configured ${this.keywordToReactionMap.size} reaction mapping(s)`,
        );
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
    priority: 'DEFAULT',
  })
  onMessagePreprocess(context: HookContext): HookResult {
    const messageId = context.message?.id || context.message?.messageId || 'unknown';

    // Skip if plugin is disabled
    if (!this.enabled) {
      return; // Continue processing
    }

    // Skip if no reaction mappings configured
    if (this.keywordToReactionMap.size === 0) {
      return; // Continue processing
    }

    // Ignore bot's own messages
    const botSelfId = context.metadata.get('botSelfId') as string;
    const messageUserId = context.message.userId?.toString();
    if (botSelfId && messageUserId && botSelfId === messageUserId) {
      return; // Continue processing (ignore bot's own messages)
    }

    // Only process group messages
    if (context.message.messageType !== 'group' || !context.message.groupId) {
      return; // Continue processing
    }

    // Only send reaction in whitelisted groups
    const isWhitelistGroup = context.metadata.get('whitelistGroup') as boolean;
    if (!isWhitelistGroup) {
      return; // Continue processing (reaction only for whitelisted groups)
    }

    // Check if message contains any configured keyword (case-insensitive)
    const messageText = context.message.message.toLowerCase();
    let matchedKeyword: string | undefined;
    let matchedReaction: string | undefined;

    for (const [keyword, reaction] of this.keywordToReactionMap.entries()) {
      if (messageText.includes(keyword)) {
        matchedKeyword = keyword;
        matchedReaction = reaction;
        break; // Use first match
      }
    }

    if (!matchedKeyword || !matchedReaction) {
      return; // Continue processing (no keyword match)
    }

    logger.info(
      `[ReactionPlugin] Keyword "${matchedKeyword}" detected in whitelisted group | messageId=${messageId} | groupId=${context.message.groupId} | reaction=${matchedReaction}`,
    );

    // Send reaction asynchronously (don't block message processing)
    this.sendReaction(context, matchedReaction).catch((error) => {
      logger.error(`[ReactionPlugin] Failed to send reaction | messageId=${messageId}:`, error);
    });

    // Continue processing (don't interrupt)
    return;
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
          message_seq: messageSeq, // Milky protocol uses message_seq (number)
          reaction: reactionId,
          is_add: true,
        },
        'milky', // Use configured protocol
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
