// Plugin loading and lifecycle management

import type { HookManager } from '@/hooks/HookManager';
import { getCoreHookPriority } from '@/hooks/HookPriority';
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

  // Plugin directory is fixed to src/plugins
  private readonly pluginDirectory: string;

  constructor(hookManager: HookManager) {
    this.hookManager = hookManager;
    // Fixed plugin directory: src/plugins/plugins
    this.pluginDirectory = join(process.cwd(), 'src', 'plugins', 'plugins');
  }

  setContext(context: PluginContext): void {
    this.context = context;
  }

  async loadPlugins(
    pluginConfigs: Array<{ name: string; enabled: boolean; config?: any }> = [],
  ): Promise<void> {
    if (!this.context) {
      throw new Error('Plugin context not set');
    }

    // Create a map of plugin configs by name for quick lookup
    const pluginConfigMap = new Map(pluginConfigs.map((p) => [p.name, p]));

    // Load plugins from fixed src/plugins directory
    if (this.dirExists(this.pluginDirectory)) {
      await this.loadPluginsFromDirectory(
        this.pluginDirectory,
        pluginConfigMap,
        true,
      );
    } else {
      logger.warn(
        `[PluginManager] Plugin directory not found: ${this.pluginDirectory}`,
      );
    }

    logger.info(
      `[PluginManager] Finished loading plugins. Total: ${this.plugins.size}`,
    );
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
    pluginConfigMap: Map<
      string,
      { name: string; enabled: boolean; config?: any }
    >,
    isBuiltin: boolean = false,
  ): Promise<void> {
    try {
      const files = readdirSync(directory);
      const pluginFiles = files.filter(
        (file) => extname(file) === '.ts' || extname(file) === '.js',
      );

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
          const PluginClass =
            pluginModule.default || pluginModule[Object.keys(pluginModule)[0]];

          if (!PluginClass) {
            logger.warn(`[PluginManager] No plugin class found in ${file}`);
            continue;
          }

          // Get plugin metadata from decorator (decorator executed during import)
          const pluginMetadata = getPluginMetadata(PluginClass);
          if (!pluginMetadata) {
            logger.warn(
              `[PluginManager] Plugin class ${PluginClass.name} is not decorated with @Plugin()`,
            );
            continue;
          }

          const plugin: Plugin = new PluginClass();

          // Verify plugin name and version match decorator metadata
          // Use decorator metadata as source of truth
          if (plugin.name !== pluginMetadata.name) {
            logger.warn(
              `[PluginManager] Plugin name mismatch: class has "${plugin.name}", decorator has "${pluginMetadata.name}". Using decorator name.`,
            );
            (plugin as any).name = pluginMetadata.name;
          }
          if (plugin.version !== pluginMetadata.version) {
            logger.warn(
              `[PluginManager] Plugin version mismatch: class has "${plugin.version}", decorator has "${pluginMetadata.version}". Using decorator version.`,
            );
            (plugin as any).version = pluginMetadata.version;
          }

          // Skip if plugin already loaded (avoid duplicates)
          if (this.plugins.has(plugin.name)) {
            logger.debug(
              `[PluginManager] Plugin ${plugin.name} already loaded, skipping duplicate`,
            );
            continue;
          }

          this.plugins.set(plugin.name, plugin);

          // Get plugin config from config list
          const pluginConfig = pluginConfigMap.get(plugin.name);

          // Initialize plugin with context
          if (plugin.onInit && this.context) {
            await plugin.onInit(this.context);
          }

          // Register hooks from plugin using decorator metadata
          // All hooks are registered (regardless of enabled state)
          const hookMetadataList = getPluginHooks(PluginClass);
          if (hookMetadataList.length > 0) {
            this.registerPluginHooksFromMetadata(
              plugin,
              hookMetadataList,
              plugin.name,
            );
          } else {
            // Fallback: register hooks from plugin interface (for backward compatibility)
            // This will be removed once all plugins use decorators
            this.registerPluginHooks(plugin, plugin.name);
          }

          // Enable if enabled in config
          if (pluginConfig?.enabled) {
            await this.enablePlugin(plugin.name);
          }

          logger.info(
            `[PluginManager] Loaded plugin: ${plugin.name} v${plugin.version} (enabled: ${pluginConfig?.enabled ?? false})${isBuiltin ? ' [built-in]' : ''}`,
          );
        } catch (error) {
          logger.error(
            `[PluginManager] Failed to load plugin ${file} from ${directory}:`,
            error,
          );
        }
      }
    } catch (error) {
      logger.error(
        `[PluginManager] Failed to read plugin directory ${directory}:`,
        error,
      );
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

    // Unregister hooks
    this.unregisterPluginHooks(name);

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
   * This is the new method using @Hook() decorator
   */
  private registerPluginHooksFromMetadata(
    plugin: Plugin,
    hookMetadataList: Array<{
      hookName: string;
      priority: string;
      methodName: string;
    }>,
    pluginName: string,
  ): void {
    let registeredCount = 0;

    for (const hookMeta of hookMetadataList) {
      // Get handler method from plugin instance
      const handler = (plugin as any)[hookMeta.methodName];
      if (typeof handler !== 'function') {
        logger.warn(
          `[PluginManager] Hook method ${hookMeta.methodName} not found in plugin ${pluginName}`,
        );
        continue;
      }

      // Calculate priority from variant
      const priority = getCoreHookPriority(
        hookMeta.hookName as any,
        hookMeta.priority as any,
      );

      // Bind handler to plugin instance to preserve 'this' context
      const boundHandler = handler.bind(plugin);
      this.hookManager.register(
        hookMeta.hookName as any,
        boundHandler,
        priority,
        pluginName,
      );
      registeredCount++;
    }

    if (registeredCount > 0) {
      logger.info(
        `[PluginManager] Registered ${registeredCount} hooks from plugin: ${pluginName} (via decorators)`,
      );
    }
  }

  /**
   * Register all hooks from a plugin (fallback method)
   * Merged from HookRegistry - registers core hooks from plugin interface
   * This is for backward compatibility until all plugins use decorators
   */
  private registerPluginHooks(plugin: Plugin, pluginName: string): void {
    // Core hooks only
    const coreHookNames: Array<keyof Plugin> = [
      'onMessageReceived',
      'onMessagePreprocess',
      'onMessageBeforeSend',
      'onMessageSent',
      'onError',
    ];

    let registeredCount = 0;

    for (const hookName of coreHookNames) {
      const handler = plugin[hookName];
      if (typeof handler === 'function') {
        // Use default priority
        const priority = getCoreHookPriority(hookName as any);

        // Bind handler to plugin instance to preserve 'this' context
        const boundHandler = handler.bind(plugin);
        this.hookManager.register(
          hookName as any,
          boundHandler as any,
          priority,
          pluginName,
        );
        registeredCount++;
      }
    }

    if (registeredCount > 0) {
      logger.info(
        `[PluginManager] Registered ${registeredCount} core hooks from plugin: ${pluginName} (fallback method)`,
      );
    }
  }

  /**
   * Register extended hooks from extensions (command system, task system, etc.)
   * Can also be used by plugins to manually register hooks with custom priority
   *
   * @param hookName - Hook name (core or extended)
   * @param handler - Hook handler function
   * @param priority - Priority (optional, uses default if not provided)
   * @param extensionName - Extension/plugin name
   */
  registerExtensionHooks(
    hookName: string,
    handler: any,
    priority?: number,
    extensionName?: string,
  ): void {
    // Priority will be set to default if not provided (handled by HookManager.register)
    this.hookManager.register(hookName, handler, priority, extensionName);
    logger.debug(
      `[PluginManager] Registered hook: ${hookName} (priority: ${priority ?? 'default'}, from: ${extensionName || 'unknown'})`,
    );
  }

  /**
   * Unregister all hooks from a plugin
   */
  private unregisterPluginHooks(pluginName: string): void {
    this.hookManager.unregisterPluginHooks(pluginName);
  }
}
