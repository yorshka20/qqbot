// Whitelist plugin - controls message processing based on user and group whitelist
// If sender is not in whitelist and message is not from whitelisted group, only post-process (no reply)
// If sender is in whitelist or message is from whitelisted group, always reply

import type { HookContext, HookResult } from '@/hooks/types';
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
  description: 'Whitelist plugin that controls message processing based on user and group whitelist',
})
export class WhitelistPlugin extends PluginBase {
  private userWhitelist: Set<string> = new Set();
  private groupWhitelist: Set<string> = new Set();

  async onInit(): Promise<void> {
    // Load plugin-specific configuration
    try {
      const pluginConfig = this.pluginConfig?.config as WhitelistPluginConfig | undefined;
      if (!pluginConfig) {
        this.enabled = false;
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

      // Plugin requires at least one whitelist (user or group) to be enabled
      if (!this.userWhitelist.size && !this.groupWhitelist.size) {
        this.enabled = false;
      }
    } catch (error) {
      logger.error('[WhitelistPlugin] Error loading config:', error);
      this.enabled = false;
    }
  }

  /**
   * Hook: onMessagePreprocess
   * Executed during PREPROCESS stage with HIGHEST priority
   * Whitelist check should be the highest priority - if user is not in whitelist and group is not in whitelist,
   * set postProcessOnly immediately to skip all processing (command, @bot check, etc.)
   *
   * Hook is always registered (decorator handles it), but checks enabled state before executing
   */
  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'HIGHEST', // Ensure whitelist check runs before command routing
    order: 0,
  })
  onMessagePreprocess(context: HookContext): HookResult {
    const userId = context.message.userId;
    const groupId = context.message.groupId;
    const messageId = context.message.id || context.message.messageId || 'unknown';

    // Skip if plugin is disabled
    if (!this.enabled) {
      return true;
    }

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
      // This will skip command routing, @bot check, and all reply generation
      context.metadata.set('postProcessOnly', true);
      logger.info(`[WhitelistPlugin] skipped due to not in whitelist | messageId=${messageId}`);
    } else {
      // User or group in whitelist - ensure postProcessOnly is not set (allow all processing)
      // Also set flags to indicate this is a whitelist user/group, so determineProcessingMode won't override
      const hadPostProcessOnly = context.metadata.has('postProcessOnly');
      if (hadPostProcessOnly) {
        context.metadata.delete('postProcessOnly');
        logger.info(`[WhitelistPlugin] cleared existing postProcessOnly flag | messageId=${messageId}`);
      } else {
        logger.info(`[WhitelistPlugin] allowing all processing | messageId=${messageId}`);
      }
      // Set flags to indicate this is a whitelist user/group
      // This prevents determineProcessingMode from setting postProcessOnly later
      if (isUserInWhitelist) {
        context.metadata.set('whitelistUser', true);
      }
      if (isGroupInWhitelist) {
        context.metadata.set('whitelistGroup', true);
      }
    }

    // Verify final state
    const finalPostProcessOnly = context.metadata.get('postProcessOnly') as boolean;
    logger.info(
      `[WhitelistPlugin] PREPROCESS hook completed | messageId=${messageId} | finalPostProcessOnly=${finalPostProcessOnly}`,
    );

    return true;
  }
}
