// Plugin loading and lifecycle management

import type { CommandContext } from '@/command/types';
import { ConversationConfigService } from '@/config/ConversationConfigService';
import { getSessionId, getSessionType } from '@/config/SessionUtils';
import { HookManager } from '@/hooks/HookManager';
import { getHookPriority } from '@/hooks/HookPriority';
import type { HookHandler } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { existsSync, readdirSync, statSync } from 'fs';
import { extname, join } from 'path';
import { getPluginHooks, getPluginMetadata, type HookMetadata } from './decorators';
import type { Plugin, PluginContext } from './types';

export class PluginManager {
  private plugins = new Map<string, Plugin>();
  private enabledPlugins = new Set<string>();

  // Plugin directory is fixed to src/plugins/plugins
  private readonly pluginDirectory = join(process.cwd(), 'src', 'plugins', 'plugins');

  constructor(
    private hookManager: HookManager,
    private context: PluginContext,
    private conversationConfigService: ConversationConfigService,
  ) { }

  async loadPlugins(pluginConfigs: Array<{ name: string; enabled: boolean; config?: unknown }> = []): Promise<void> {
    const pluginConfigMap = new Map(pluginConfigs.map((p) => [p.name, p]));

    // Load plugins from fixed src/plugins directory
    if (this.dirExists(this.pluginDirectory)) {
      await this.loadPluginsFromDirectory(this.pluginDirectory, pluginConfigMap, true);
    }

    logger.info(`📦 [PluginManager] Finished loading plugins. Total: ${this.plugins.size}`);
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
    pluginConfigMap: Map<string, { name: string; enabled: boolean; config?: unknown }>,
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

        // setup plugin context and configuration
        const pluginConfig = pluginConfigMap.get(plugin.name);
        plugin.loadConfig(this.context, pluginConfig);

        await plugin.onInit?.();

        if (pluginConfig?.enabled) {
          await this.enablePlugin(plugin.name);
        }

        // Register hooks from plugin using decorator metadata
        const hookMetadataList = getPluginHooks(PluginClass);
        if (hookMetadataList.length > 0) {
          this.registerPluginHooksFromMetadata(plugin, hookMetadataList, plugin.name);
        }

        logger.info(
          `✅ [PluginManager] Loaded plugin: ${plugin.name} v${plugin.version} (enabled: ${pluginConfig?.enabled ?? false})${isBuiltin ? ' [built-in]' : ''}`,
        );
      } catch (error) {
        logger.error(`❌ [PluginManager] Failed to load plugin ${file} from ${directory}:`, error);
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

    await plugin.onEnable?.();

    this.enabledPlugins.add(name);
    logger.info(`▶️ [PluginManager] Enabled plugin: ${name}`);
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
    logger.info(`⏸️ [PluginManager] Disabled plugin: ${name}`);
  }

  getPlugin(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get plugin with type assertion
   * @param name - Plugin name
   * @returns Plugin instance cast to type T, or undefined if not found
   */
  getPluginAs<T extends Plugin>(name: string): T | undefined {
    return this.plugins.get(name) as T | undefined;
  }

  getEnabledPlugins(): string[] {
    return Array.from(this.enabledPlugins);
  }

  getAllPlugins(): Plugin[] {
    return Array.from(this.plugins.values());
  }


  /**
   * Enable a plugin for a conversation
   * @param pluginName - Plugin name to enable
   * @param context - Command context to extract session info
   * @param isGlobal - If true, enable globally (not persisted, reset on restart)
   */
  async enablePluginForConversation(
    pluginName: string,
    context: CommandContext,
    isGlobal: boolean = false,
  ): Promise<void> {
    if (isGlobal) {
      // Enable globally (not persisted)
      await this.enablePlugin(pluginName);
      logger.info(`[PluginManager] Enabled plugin: ${pluginName} (globally, not persisted)`);
      return;
    }

    // Enable for conversation (persisted)
    const sessionId = getSessionId(context);
    const sessionType = getSessionType(context);
    await this.conversationConfigService.enablePlugin(pluginName, sessionId, sessionType);
    logger.info(`[PluginManager] Enabled plugin "${pluginName}" for ${sessionType}:${sessionId}`);
  }

  /**
   * Disable a plugin for a conversation
   * @param pluginName - Plugin name to disable
   * @param context - Command context to extract session info
   * @param isGlobal - If true, disable globally (not persisted, reset on restart)
   */
  async disablePluginForConversation(
    pluginName: string,
    context: CommandContext,
    isGlobal: boolean = false,
  ): Promise<void> {
    if (isGlobal) {
      // Disable globally (not persisted)
      await this.disablePlugin(pluginName);
      logger.info(`[PluginManager] Disabled plugin: ${pluginName} (globally, not persisted)`);
      return;
    }

    // Disable for conversation (persisted)
    const sessionId = getSessionId(context);
    const sessionType = getSessionType(context);
    await this.conversationConfigService.disablePlugin(pluginName, sessionId, sessionType);
    logger.info(`[PluginManager] Disabled plugin "${pluginName}" for ${sessionType}:${sessionId}`);
  }

  /**
   * Check if a plugin is enabled for a specific session
   * @param pluginName - Plugin name to check
   * @param context - Command context to extract session info
   * @returns true if plugin is enabled, false otherwise
   */
  async isPluginEnabledForConversation(
    pluginName: string,
    context: CommandContext,
  ): Promise<boolean> {
    // Check if plugin is globally enabled first
    if (!this.enabledPlugins.has(pluginName)) {
      return false;
    }

    // Check conversation config
    const sessionId = getSessionId(context);
    const sessionType = getSessionType(context);
    const conversationEnabled = await this.conversationConfigService.getPluginEnabled(
      pluginName,
      sessionId,
      sessionType,
    );

    return conversationEnabled ?? true;
  }

  /**
   * Register hooks from plugin using decorator metadata
   * Simplified: just add handlers to hooks
   */
  private registerPluginHooksFromMetadata(
    plugin: Plugin,
    hookMetadataList: Array<HookMetadata>,
    pluginName: string,
  ): void {
    for (const hookMeta of hookMetadataList) {
      const handler = plugin[hookMeta.methodName as keyof Plugin];
      if (typeof handler !== 'function') {
        logger.warn(`[PluginManager] Hook method ${hookMeta.methodName} not found in plugin ${pluginName}`);
        continue;
      }

      // Calculate priority from variant
      const priority = getHookPriority(hookMeta.hookName, hookMeta.priority, hookMeta.order);

      // Bind handler to plugin instance to preserve 'this' context
      const boundHandler = handler.bind(plugin) as HookHandler;
      this.hookManager.addHandler(hookMeta.hookName, boundHandler, priority);
    }
  }
}
