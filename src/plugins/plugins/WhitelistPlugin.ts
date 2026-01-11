// Whitelist plugin - controls message processing based on user whitelist
// If sender is not in whitelist, only post-process (no reply)
// If sender is in whitelist, always reply

import type { BotConfig } from '@/core/Config';
import type { HookContext, HookResult } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { Hook, Plugin } from '../decorators';
import { PluginBase } from '../PluginBase';
import type { PluginContext } from '../types';

interface WhitelistPluginConfig {
  enabled?: boolean;
  userIds?: string[];
}

@Plugin({
  name: 'whitelist',
  version: '1.0.0',
  description:
    'Whitelist plugin that controls message processing based on user whitelist',
})
export class WhitelistPlugin extends PluginBase {
  readonly name = 'whitelist';
  readonly version = '1.0.0';
  readonly description =
    'Whitelist plugin that controls message processing based on user whitelist';

  private whitelist: Set<string> = new Set();
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
        logger.warn(
          `[WhitelistPlugin] No plugin entry found in config.plugins.list for plugin: ${this.name}`,
        );
        this.enabled = false;
        return;
      }

      const pluginConfig = pluginEntry.config as
        | WhitelistPluginConfig
        | undefined;

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

      if (pluginConfig.userIds && Array.isArray(pluginConfig.userIds)) {
        this.whitelist = new Set(pluginConfig.userIds);
        logger.info(
          `[WhitelistPlugin] Loaded whitelist with ${this.whitelist.size} user(s): ${Array.from(this.whitelist).join(', ')}`,
        );
      } else {
        logger.warn(
          '[WhitelistPlugin] No user IDs found in whitelist configuration',
        );
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
   * Whitelist check should be the highest priority - if user is not in whitelist,
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
    const messageId =
      context.message?.id || context.message?.messageId || 'unknown';

    logger.info(
      `[WhitelistPlugin] PREPROCESS hook triggered | messageId=${messageId} | userId=${userId} | pluginEnabled=${this.enabled} | whitelistSize=${this.whitelist.size}`,
    );

    // Skip if plugin is disabled
    if (!this.enabled) {
      logger.info(
        `[WhitelistPlugin] Plugin is disabled, skipping whitelist check | messageId=${messageId}`,
      );
      return; // Continue processing
    }

    const userIdStr = userId.toString();
    const isInWhitelist = this.whitelist.has(userIdStr);
    const whitelistEntries = Array.from(this.whitelist);

    logger.info(
      `[WhitelistPlugin] Checking whitelist | messageId=${messageId} | userId=${userId} | userIdStr=${userIdStr} | isInWhitelist=${isInWhitelist} | whitelistEntries=[${whitelistEntries.join(', ')}]`,
    );

    if (!isInWhitelist) {
      // User not in whitelist - set postProcessOnly flag immediately
      // This will skip command routing, @bot check, and all reply generation
      context.metadata.set('postProcessOnly', true);
      logger.info(
        `[WhitelistPlugin] ✗ User ${userId} NOT in whitelist, SET postProcessOnly=true | messageId=${messageId}`,
      );
    } else {
      // User in whitelist - ensure postProcessOnly is not set (allow all processing)
      const hadPostProcessOnly = context.metadata.has('postProcessOnly');
      if (hadPostProcessOnly) {
        context.metadata.delete('postProcessOnly');
        logger.info(
          `[WhitelistPlugin] ✓ User ${userId} is in whitelist, CLEARED existing postProcessOnly flag | messageId=${messageId}`,
        );
      } else {
        logger.info(
          `[WhitelistPlugin] ✓ User ${userId} is in whitelist, allowing all processing | messageId=${messageId}`,
        );
      }
    }

    // Verify final state
    const finalPostProcessOnly = context.metadata.get(
      'postProcessOnly',
    ) as boolean;
    logger.info(
      `[WhitelistPlugin] PREPROCESS hook completed | messageId=${messageId} | finalPostProcessOnly=${finalPostProcessOnly}`,
    );

    // Continue processing (don't interrupt)
    return;
  }
}
