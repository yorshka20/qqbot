// Whitelist plugin - controls message processing based on user and group whitelist
// Also handles core access control: bot's own messages and @bot requirement for group chat
// If sender is not in whitelist and message is not from whitelisted group, only post-process (no reply)
// If sender is in whitelist or message is from whitelisted group, always reply

import type { HookContext, HookResult } from '@/hooks/types';
import { MessageUtils } from '@/message/MessageUtils';
import { logger } from '@/utils/logger';
import { Hook, Plugin } from '../decorators';
import { PluginBase } from '../PluginBase';

interface WhitelistPluginConfig {
  userIds?: string[];
  groupIds?: string[]; // Group whitelist - messages from these groups are always allowed
}

@Plugin({
  name: 'whitelist',
  version: '1.0.0',
  description:
    'Whitelist plugin that controls message processing based on user and group whitelist. Also handles core access control (bot own messages, @bot requirement)',
})
export class WhitelistPlugin extends PluginBase {
  private userWhitelist: Set<string> = new Set();
  private groupWhitelist: Set<string> = new Set();
  private whitelistEnabled = false; // Whether whitelist filtering is enabled (has config)

  async onInit(): Promise<void> {
    // Load plugin-specific configuration
    try {
      const pluginConfig = this.pluginConfig?.config as WhitelistPluginConfig | undefined;

      // Plugin is ALWAYS enabled for core access control (bot own messages, @bot check)
      // Whitelist filtering is only enabled if config is provided
      this.enabled = true;

      if (!pluginConfig) {
        this.whitelistEnabled = false;
        logger.info('[WhitelistPlugin] No config provided, core access control only (bot own messages, @bot check)');
        return;
      }

      // Load user whitelist
      if (pluginConfig.userIds && Array.isArray(pluginConfig.userIds)) {
        this.userWhitelist = new Set(pluginConfig.userIds);
        logger.info(
          `[WhitelistPlugin] Loaded user whitelist with ${this.userWhitelist.size} user(s): ${Array.from(this.userWhitelist).join(', ')}`,
        );
      }

      // Load group whitelist
      if (pluginConfig.groupIds && Array.isArray(pluginConfig.groupIds)) {
        this.groupWhitelist = new Set(pluginConfig.groupIds);
        logger.info(
          `[WhitelistPlugin] Loaded group whitelist with ${this.groupWhitelist.size} group(s): ${Array.from(this.groupWhitelist).join(', ')}`,
        );
      }

      // Enable whitelist filtering if at least one whitelist is configured
      this.whitelistEnabled = this.userWhitelist.size > 0 || this.groupWhitelist.size > 0;

      if (this.whitelistEnabled) {
        logger.info('[WhitelistPlugin] Whitelist filtering enabled');
      } else {
        logger.info('[WhitelistPlugin] Whitelist filtering disabled (empty config), core access control only');
      }
    } catch (error) {
      logger.error('[WhitelistPlugin] Error loading config:', error);
      // Still enable plugin for core access control even if config fails
      this.whitelistEnabled = false;
    }
  }

  /**
   * Hook: onMessagePreprocess
   * Executed during PREPROCESS stage with HIGHEST priority
   *
   * Always executes core access control:
   * 1. Bot's own messages check
   * 2. Group chat @bot requirement
   *
   * If whitelist is enabled (has config), also performs:
   * 3. Whitelist check
   */
  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'HIGHEST', // Ensure access control runs before command routing
    order: 0,
  })
  onMessagePreprocess(context: HookContext): HookResult {
    const userId = context.message.userId;
    const groupId = context.message.groupId;
    const messageId = context.message.id || context.message.messageId || 'unknown';

    // Core access control 1: Check bot's own messages
    const botSelfId = context.metadata.get('botSelfId');
    const messageUserId = context.message.userId?.toString();
    if (botSelfId && messageUserId && botSelfId === messageUserId) {
      context.metadata.set('postProcessOnly', true);
      logger.info(`[WhitelistPlugin] Bot's own message, skip processing | messageId=${messageId}`);
      return true;
    }

    // Core access control 2 & Whitelist check (if enabled)
    const messageType = context.message.messageType;

    if (this.whitelistEnabled) {
      // Whitelist filtering is enabled - check whitelist first
      const userIdStr = userId.toString();
      const isUserInWhitelist = this.userWhitelist.has(userIdStr);

      // Check if message is from a whitelisted group
      let isGroupInWhitelist = false;
      if (groupId) {
        const groupIdStr = groupId.toString();
        isGroupInWhitelist = this.groupWhitelist.has(groupIdStr);
      }

      const isAllowed = isUserInWhitelist || isGroupInWhitelist;

      if (!isAllowed) {
        // User not in whitelist and group not in whitelist - set postProcessOnly flag immediately
        context.metadata.set('postProcessOnly', true);
        logger.info(`[WhitelistPlugin] Not in whitelist, skip processing | messageId=${messageId}`);
        return true;
      }

      // User or group in whitelist - clear any existing postProcessOnly and set flags
      const hadPostProcessOnly = context.metadata.has('postProcessOnly');
      if (hadPostProcessOnly) {
        context.metadata.delete('postProcessOnly');
        logger.info(`[WhitelistPlugin] Cleared existing postProcessOnly flag | messageId=${messageId}`);
      }

      // Set flags to indicate this is a whitelist user/group
      if (isUserInWhitelist) {
        context.metadata.set('whitelistUser', true);
      }
      if (isGroupInWhitelist) {
        context.metadata.set('whitelistGroup', true);
      }
    } else {
      // Whitelist filtering is disabled - allow all messages (for core access control)
      // Set flags to indicate no whitelist restriction
      context.metadata.set('whitelistUser', true); // Treat as whitelisted
      if (messageType === 'group') {
        context.metadata.set('whitelistGroup', true); // Treat as whitelisted
      }
    }

    // Core access control 2: Group chat @bot requirement
    // Only applies to group chat (private chat doesn't need @bot)
    if (messageType === 'group') {
      const isAtBot = MessageUtils.isAtBot(context.message, botSelfId);
      if (!isAtBot) {
        // Not @bot in group chat - set postProcessOnly
        context.metadata.set('postProcessOnly', true);
        logger.info(`[WhitelistPlugin] Group chat not @bot, skip processing | messageId=${messageId}`);
        return true;
      }
      // @bot in group chat - allow processing
      logger.debug(`[WhitelistPlugin] Group chat @bot, allow processing | messageId=${messageId}`);
    } else {
      // Private chat - no @bot requirement
      logger.debug(`[WhitelistPlugin] Private chat, allow processing | messageId=${messageId}`);
    }

    // Verify final state
    const finalPostProcessOnly = context.metadata.get('postProcessOnly');
    logger.info(
      `[WhitelistPlugin] PREPROCESS hook completed | messageId=${messageId} | whitelistEnabled=${this.whitelistEnabled} | postProcessOnly=${finalPostProcessOnly}`,
    );

    return true;
  }
}
