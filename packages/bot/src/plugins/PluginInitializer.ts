// Plugin Initializer - loading plugins at startup.

import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { PluginManager } from './PluginManager';

export interface PluginSystem {
  pluginManager: PluginManager;
}

export class PluginInitializer {
  /**
   * Load every registered plugin (onInit) and enable the ones enabled in config (onEnable).
   * @param config - Bot configuration (passed in directly)
   */
  static async loadPlugins(config: Config): Promise<void> {
    const container = getContainer();
    const pluginManager = container.resolve(PluginManager);
    const pluginsConfig = config.getPluginsConfig();
    await pluginManager.loadPlugins(pluginsConfig.list);
  }
}
