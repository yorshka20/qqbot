// Plugin Initializer - initializes PluginManager and loads plugins

import type { APIClient } from '@/api/APIClient';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { Config } from '@/core/config';
import type { EventRouter } from '@/events/EventRouter';
import type { HookManager } from '@/hooks/HookManager';
import { logger } from '@/utils/logger';
import { PluginManager } from './PluginManager';

export interface PluginSystem {
  pluginManager: PluginManager;
}

/**
 * Plugin Initializer
 * Initializes PluginManager and loads plugins
 */
export class PluginInitializer {
  /**
   * Initialize plugin system
   * @param config - Bot configuration
   * @param hookManager - Hook manager
   * @param apiClient - API client
   * @param eventRouter - Event router
   * @returns Initialized plugin system
   */
  static initialize(
    config: Config,
    hookManager: HookManager,
    apiClient: APIClient,
    eventRouter: EventRouter,
  ): PluginSystem {
    logger.info('[PluginInitializer] Starting initialization...');

    const pluginManager = new PluginManager(hookManager);
    pluginManager.setContext({
      api: apiClient,
      events: eventRouter,
      bot: {
        getConfig: () => config.getConfig(),
      },
    });

    logger.info('[PluginInitializer] PluginManager initialized');

    // Register PluginManager to DI container
    const container = getContainer();
    container.registerInstance(DITokens.PLUGIN_MANAGER, pluginManager);

    return {
      pluginManager,
    };
  }

  /**
   * Load plugins after bot is started
   * @param pluginSystem - Plugin system from initialize
   * @param config - Bot configuration
   */
  static async loadPlugins(pluginSystem: PluginSystem, config: Config): Promise<void> {
    const pluginsConfig = config.getPluginsConfig();
    await pluginSystem.pluginManager.loadPlugins(pluginsConfig.list);
  }
}
