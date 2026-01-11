// Whitelist plugin - controls message processing based on user and group whitelist
// If sender is not in whitelist and message is not from whitelisted group, only post-process (no reply)
// If sender is in whitelist or message is from whitelisted group, always reply

import type { BotConfig } from '@/core/Config';
import type { HookContext, HookResult } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { Hook, Plugin } from '../decorators';
import { PluginBase } from '../PluginBase';
import type { PluginContext } from '../types';

interface WhitelistPluginConfig {
  enabled?: boolean;
  userIds?: string[];
  groupIds?: string[]; // Group whitelist - messages from these groups are always allowed
}

@Plugin({
  name: 'whitelist',
  version: '1.0.0',
  description: 'Whitelist plugin that controls message processing based on user and group whitelist',
})
export class WhitelistPlugin extends PluginBase {
  readonly name = 'whitelist';
  readonly version = '1.0.0';
  readonly description = 'Whitelist plugin that controls message processing based on user and group whitelist';

  private userWhitelist: Set<string> = new Set();
  private groupWhitelist: Set<string> = new Set();
  private enabled: boolean = false;

  async onInit(context: PluginContext): Promise<void> {
    this.context = context;
    this.loadConfig();
  }

  /**
   * Load whitelist configuration from bot config
   * Each plugin reads its own config from config.plugins.list[pluginName].config
   */
  private loadConfig(): void {
    try {
      const config = this.context?.bot.getConfig() as BotConfig;
      if (!config) {
        logger.warn('[WhitelistPlugin] Failed to load config');
        this.enabled = false;
        return;
      }

      // Get plugin-specific config from config.plugins.list
      // Find the plugin entry by name and get its config
      const pluginEntry = config.plugins.list.find((p) => p.name === this.name);

      if (!pluginEntry) {
        logger.warn(`[WhitelistPlugin] No plugin entry found in config.plugins.list for plugin: ${this.name}`);
        this.enabled = false;
        return;
      }

      const pluginConfig = pluginEntry.config as WhitelistPluginConfig | undefined;

      if (!pluginConfig) {
        logger.warn(
          `[WhitelistPlugin] No configuration found for plugin: ${this.name}. Please add config in config.plugins.list`,
        );
        this.enabled = false;
        return;
      }

      // Plugin enabled state is determined by pluginEntry.enabled, not pluginConfig.enabled
      // pluginConfig.enabled is for plugin-specific feature toggle
      this.enabled = pluginEntry.enabled && pluginConfig.enabled !== false;

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
      if (this.userWhitelist.size === 0 && this.groupWhitelist.size === 0) {
        logger.warn('[WhitelistPlugin] No user IDs or group IDs found in whitelist configuration');
        this.enabled = false;
      }
    } catch (error) {
      logger.error('[WhitelistPlugin] Error loading config:', error);
      this.enabled = false;
    }
  }

  /**
   * Hook: onMessagePreprocess
   * Executed during PREPROCESS stage with EARLY priority
   * Whitelist check should be the highest priority - if user is not in whitelist and group is not in whitelist,
   * set postProcessOnly immediately to skip all processing (command, @bot check, etc.)
   *
   * Hook is always registered (decorator handles it), but checks enabled state before executing
   */
  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'EARLY', // Ensure whitelist check runs before command routing
  })
  onMessagePreprocess(context: HookContext): HookResult {
    const userId = context.message.userId;
    const groupId = context.message.groupId;
    const messageId = context.message?.id || context.message?.messageId || 'unknown';

    logger.info(
      `[WhitelistPlugin] PREPROCESS hook triggered | messageId=${messageId} | userId=${userId} | groupId=${groupId} | pluginEnabled=${this.enabled} | userWhitelistSize=${this.userWhitelist.size} | groupWhitelistSize=${this.groupWhitelist.size}`,
    );

    // Skip if plugin is disabled
    if (!this.enabled) {
      logger.info(`[WhitelistPlugin] Plugin is disabled, skipping whitelist check | messageId=${messageId}`);
      return; // Continue processing
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

    logger.info(
      `[WhitelistPlugin] Checking whitelist | messageId=${messageId} | userId=${userId} | userIdStr=${userIdStr} | groupId=${groupId} | isUserInWhitelist=${isUserInWhitelist} | isGroupInWhitelist=${isGroupInWhitelist} | isAllowed=${isAllowed}`,
    );

    if (!isAllowed) {
      // User not in whitelist and group not in whitelist - set postProcessOnly flag immediately
      // This will skip command routing, @bot check, and all reply generation
      context.metadata.set('postProcessOnly', true);
      logger.info(
        `[WhitelistPlugin] ✗ User ${userId} and group ${groupId || 'N/A'} NOT in whitelist, SET postProcessOnly=true | messageId=${messageId}`,
      );
    } else {
      // User or group in whitelist - ensure postProcessOnly is not set (allow all processing)
      // Also set flags to indicate this is a whitelist user/group, so determineProcessingMode won't override
      const hadPostProcessOnly = context.metadata.has('postProcessOnly');
      if (hadPostProcessOnly) {
        context.metadata.delete('postProcessOnly');
        logger.info(
          `[WhitelistPlugin] ✓ User ${userId} or group ${groupId || 'N/A'} is in whitelist, CLEARED existing postProcessOnly flag | messageId=${messageId}`,
        );
      } else {
        logger.info(
          `[WhitelistPlugin] ✓ User ${userId} or group ${groupId || 'N/A'} is in whitelist, allowing all processing | messageId=${messageId}`,
        );
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

    // Continue processing (don't interrupt)
    return;
  }
}
