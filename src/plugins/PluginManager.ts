// Plugin loading and lifecycle management

import { readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import type { Plugin, PluginContext, PluginInfo } from './types';
import { logger } from '@/utils/logger';

export class PluginManager {
  private plugins = new Map<string, Plugin>();
  private enabledPlugins = new Set<string>();
  private context?: PluginContext;

  constructor(private pluginDirectory: string) {}

  setContext(context: PluginContext): void {
    this.context = context;
  }

  async loadPlugins(enabledPluginNames: string[] = []): Promise<void> {
    if (!this.context) {
      throw new Error('Plugin context not set');
    }

    try {
      const files = readdirSync(this.pluginDirectory);
      const pluginFiles = files.filter(
        (file) => extname(file) === '.ts' || extname(file) === '.js'
      );

      logger.info(`[PluginManager] Found ${pluginFiles.length} plugin file(s)`);

      for (const file of pluginFiles) {
        try {
          const pluginPath = join(this.pluginDirectory, file);
          const pluginModule = await import(pluginPath);
          
          // Support both default export and named export
          const PluginClass = pluginModule.default || pluginModule[Object.keys(pluginModule)[0]];
          
          if (!PluginClass) {
            logger.warn(`[PluginManager] No plugin class found in ${file}`);
            continue;
          }

          const plugin: Plugin = new PluginClass();
          
          if (!plugin.name || !plugin.version) {
            logger.warn(`[PluginManager] Invalid plugin in ${file}: missing name or version`);
            continue;
          }

          this.plugins.set(plugin.name, plugin);

          // Initialize plugin
          if (plugin.onInit) {
            await plugin.onInit(this.context);
          }

          // Enable if in enabled list
          if (enabledPluginNames.includes(plugin.name)) {
            await this.enablePlugin(plugin.name);
          }

          logger.info(`[PluginManager] Loaded plugin: ${plugin.name} v${plugin.version}`);
        } catch (error) {
          logger.error(`[PluginManager] Failed to load plugin ${file}:`, error);
        }
      }
    } catch (error) {
      logger.error(`[PluginManager] Failed to read plugin directory:`, error);
    }
  }

  async enablePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} not found`);
    }

    if (this.enabledPlugins.has(name)) {
      logger.warn(`[PluginManager] Plugin ${name} is already enabled`);
      return;
    }

    if (!this.context) {
      throw new Error('Plugin context not set');
    }

    if (plugin.onEnable) {
      await plugin.onEnable(this.context);
    }

    this.enabledPlugins.add(name);
    logger.info(`[PluginManager] Enabled plugin: ${name}`);
  }

  async disablePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} not found`);
    }

    if (!this.enabledPlugins.has(name)) {
      logger.warn(`[PluginManager] Plugin ${name} is not enabled`);
      return;
    }

    if (plugin.onDisable) {
      await plugin.onDisable();
    }

    this.enabledPlugins.delete(name);
    logger.info(`[PluginManager] Disabled plugin: ${name}`);
  }

  getPlugin(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  getEnabledPlugins(): string[] {
    return Array.from(this.enabledPlugins);
  }

  getAllPlugins(): Plugin[] {
    return Array.from(this.plugins.values());
  }
}
