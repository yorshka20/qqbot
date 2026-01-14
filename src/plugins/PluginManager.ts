// Plugin loading and lifecycle management

import { HookManager } from '@/hooks/HookManager';
import { getHookPriority, HookPriorityVariant } from '@/hooks/HookPriority';
import type { HookHandler } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { existsSync, readdirSync, statSync } from 'fs';
import { extname, join } from 'path';
import { getPluginHooks, getPluginMetadata } from './decorators';
import type { Plugin, PluginContext } from './types';

export class PluginManager {
  private plugins = new Map<string, Plugin>();
  private enabledPlugins = new Set<string>();
  private context?: PluginContext;
  private hookManager: HookManager;

  // Plugin directory is fixed to src/plugins/plugins
  private readonly pluginDirectory = join(process.cwd(), 'src', 'plugins', 'plugins');

  constructor(hookManager: HookManager) {
    this.hookManager = hookManager;
  }

  setContext(context: PluginContext): void {
    this.context = context;
  }

  async loadPlugins(pluginConfigs: Array<{ name: string; enabled: boolean; config?: any }> = []): Promise<void> {
    if (!this.context) {
      throw new Error('Plugin context not set');
    }

    // Create a map of plugin configs by name for quick lookup
    const pluginConfigMap = new Map(pluginConfigs.map((p) => [p.name, p]));

    // Load plugins from fixed src/plugins directory
    if (this.dirExists(this.pluginDirectory)) {
      await this.loadPluginsFromDirectory(this.pluginDirectory, pluginConfigMap, true);
    }

    logger.info(`[PluginManager] Finished loading plugins. Total: ${this.plugins.size}`);
  }

  /**
   * Check if directory exists
   */
  private dirExists(dir: string): boolean {
    try {
      return existsSync(dir) && statSync(dir).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Load plugins from a specific directory
   */
  private async loadPluginsFromDirectory(
    directory: string,
    pluginConfigMap: Map<string, { name: string; enabled: boolean; config?: any }>,
    isBuiltin: boolean = false,
  ): Promise<void> {
    const files = readdirSync(directory);
    const pluginFiles = files.filter((file) => extname(file) === '.ts' || extname(file) === '.js');

    if (pluginFiles.length > 0) {
      logger.info(
        `[PluginManager] Found ${pluginFiles.length} plugin file(s) in ${isBuiltin ? 'built-in' : ''} directory: ${directory}`,
      );
    }

    for (const file of pluginFiles) {
      try {
        const pluginPath = join(directory, file);
        const pluginModule = await import(pluginPath);

        // Support both default export and named export
        const PluginClass = pluginModule.default || pluginModule[Object.keys(pluginModule)[0]];

        if (!PluginClass) {
          logger.warn(`[PluginManager] No plugin class found in ${file}`);
          continue;
        }

        // Get plugin metadata from decorator (decorator executed during import)
        const pluginMetadata = getPluginMetadata(PluginClass);
        if (!pluginMetadata) {
          logger.warn(`[PluginManager] Plugin class ${PluginClass.name} is not decorated with @Plugin()`);
          continue;
        }

        const plugin: Plugin = new PluginClass(pluginMetadata);

        if (this.plugins.has(plugin.name)) {
          continue;
        }

        this.plugins.set(plugin.name, plugin);

        const pluginConfig = pluginConfigMap.get(plugin.name);

        // Initialize plugin with context
        if (plugin.onInit && this.context) {
          await plugin.onInit(this.context);
        }

        // Register hooks from plugin using decorator metadata
        const hookMetadataList = getPluginHooks(PluginClass);
        if (hookMetadataList.length > 0) {
          this.registerPluginHooksFromMetadata(plugin, hookMetadataList, plugin.name);
        }

        // Enable if enabled in config
        if (pluginConfig?.enabled) {
          await this.enablePlugin(plugin.name);
        }

        logger.info(
          `[PluginManager] Loaded plugin: ${plugin.name} v${plugin.version} (enabled: ${pluginConfig?.enabled ?? false})${isBuiltin ? ' [built-in]' : ''}`,
        );
      } catch (error) {
        logger.error(`[PluginManager] Failed to load plugin ${file} from ${directory}:`, error);
      }
    }
  }

  async enablePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} not found`);
    }

    if (this.enabledPlugins.has(name)) {
      return;
    }

    if (!this.context) {
      throw new Error('Plugin context not set');
    }

    await plugin.onEnable?.(this.context);

    this.enabledPlugins.add(name);
    logger.info(`[PluginManager] Enabled plugin: ${name}`);
  }

  async disablePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} not found`);
    }

    if (!this.enabledPlugins.has(name)) {
      return;
    }

    await plugin.onDisable?.();

    // todo: should we unregister plugin from hook?
    this.hookManager.unregister(name);

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

  /**
   * Register hooks from plugin using decorator metadata
   * Simplified: just add handlers to hooks
   */
  private registerPluginHooksFromMetadata(
    plugin: Plugin,
    hookMetadataList: Array<{
      hookName: string;
      priority: HookPriorityVariant;
      methodName: string;
    }>,
    pluginName: string,
  ): void {
    for (const hookMeta of hookMetadataList) {
      logger.info(`[PluginManager] metadata: ${JSON.stringify(hookMeta)}`);
      // Get handler method from plugin instance
      const handler = plugin[hookMeta.methodName as keyof Plugin];
      if (typeof handler !== 'function') {
        logger.warn(`[PluginManager] Hook method ${hookMeta.methodName} not found in plugin ${pluginName}`);
        continue;
      }

      // Calculate priority from variant
      const priority = getHookPriority(hookMeta.hookName, hookMeta.priority);

      // Bind handler to plugin instance to preserve 'this' context
      const boundHandler = handler.bind(plugin) as HookHandler;
      this.hookManager.addHandler(hookMeta.hookName, boundHandler, priority);
    }
  }
}
