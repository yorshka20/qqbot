// Plugin Initializer - initializes PluginManager and loads plugins
// Must run BEFORE ConversationInitializer. Registers a factory for PLUGIN_MANAGER;
// PluginManager is created on first resolve (after ConversationInitializer has registered deps).

import type { APIClient } from '@/api/APIClient';
import type { ConversationConfigService } from '@/config/ConversationConfigService';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { EventRouter } from '@/events/EventRouter';
import type { HookManager } from '@/hooks/HookManager';
import { logger } from '@/utils/logger';
import { PluginManager } from './PluginManager';

export interface PluginSystem {
  pluginManager: PluginManager;
}

/** Cached PluginManager instance (created on first resolve from factory). */
let cachedPluginManager: PluginManager | null = null;

/**
 * Plugin Initializer
 * Must run BEFORE ConversationInitializer. Only registers a factory for PLUGIN_MANAGER;
 * the factory runs on first resolve (after ConversationInitializer has registered deps).
 */
export class PluginInitializer {
  /**
   * Register plugin system: must run BEFORE ConversationInitializer.
   * Registers a factory for PLUGIN_MANAGER; instance is created on first resolve.
   * @param config - Passed in at call site; used as PluginManager's config (same instance as loadPlugins(config) later).
   */
  static initialize(config: Config): void {
    logger.info('[PluginInitializer] Registering PluginManager factory (no later than ConversationInitializer)...');

    const container = getContainer();

    container.registerFactory(DITokens.PLUGIN_MANAGER, (c) => {
      if (cachedPluginManager !== null) {
        return cachedPluginManager;
      }
      const deps = {
        apiClient: c.resolve<APIClient>(DITokens.API_CLIENT),
        eventRouter: c.resolve<EventRouter>(DITokens.EVENT_ROUTER),
        config,
        hookManager: c.resolve<HookManager>(DITokens.HOOK_MANAGER),
        conversationConfigService: c.resolve<ConversationConfigService>(
          DITokens.CONVERSATION_CONFIG_SERVICE,
        ),
      };
      cachedPluginManager = new PluginManager(deps);
      logger.info('[PluginInitializer] PluginManager created (first resolve)');
      return cachedPluginManager;
    });
  }

  /**
   * Load plugins after bot is started.
   * @param config - Bot configuration (passed in directly)
   */
  static async loadPlugins(config: Config): Promise<void> {
    const container = getContainer();
    const pluginManager = container.resolve<PluginManager>(DITokens.PLUGIN_MANAGER);
    const pluginsConfig = config.getPluginsConfig();
    await pluginManager.loadPlugins(pluginsConfig.list);
  }
}
