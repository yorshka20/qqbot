// Plugin loading and lifecycle management
//
// Plugins register themselves via the `@RegisterPlugin` decorator at import
// time. Bootstrap (the composition root) imports the builtins barrel
// (`@/plugins/plugins`) so their decorators fire and populate the static plugin
// registry (see `decorators.ts`). PluginManager then iterates that registry
// — it does NOT walk the filesystem, and it does not import the plugins
// itself: they depend on services PluginManager's consumers also use, so
// importing them here would close an import cycle. Mirrors the CommandManager
// registry-consumption pattern.
//
// Other plugin sources register themselves through their own initialization
// paths so that PluginManager stays unaware of integrations / services / third-party:
//   - Service-owned plugins (e.g. ClaudeCodePlugin under
//     `services/claudeCode/plugins/`) — registered via the service module's
//     own re-exports (`services/claudeCode/index.ts`), imported by
//     bootstrap.
//   - Integration-owned plugins (e.g. avatar plugins under
//     `integrations/avatar/plugins/`) — registered by the integration's
//     bootstrap block in `core/bootstrap.ts`, which side-effect imports
//     the integration's plugin barrel.
//   - Third-party plugins under `<repo>/plugins/` are NOT YET SUPPORTED —
//     see `plugins/README.md` for the open design questions.

import { inject, singleton } from 'tsyringe';
import type { APIClient } from '@/api/APIClient';
import type { CommandContext } from '@/command/types';
import { ConversationConfigService } from '@/conversation/ConversationConfigService';
import type { Config } from '@/core/config';
import { getSessionId, getSessionType } from '@/core/config/SessionUtils';
import { DITokens } from '@/core/DITokens';
import type { EventRouter } from '@/events/EventRouter';
import { HookManager } from '@/hooks/HookManager';
import { getHookPriority } from '@/hooks/HookPriority';
import type { HookHandler } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { getAllPluginMetadata, getPluginHooks, type HookMetadata, type PluginMetadata } from './decorators';
import type { Plugin, PluginContext } from './types';

@singleton()
export class PluginManager {
  private plugins = new Map<string, Plugin>();
  private enabledPlugins = new Set<string>();
  private startedPlugins = new Set<string>();
  private running = false;

  // EVENT_ROUTER is registered by the event-system startup step, so the manager is first
  // resolved after it (plugin loading is the step right after).
  constructor(
    @inject(DITokens.API_CLIENT) private readonly apiClient: APIClient,
    @inject(DITokens.EVENT_ROUTER) private readonly eventRouter: EventRouter,
    @inject(DITokens.CONFIG) private readonly config: Config,
    @inject(HookManager) private readonly hookManager: HookManager,
    @inject(ConversationConfigService)
    private readonly conversationConfigService: ConversationConfigService,
  ) {}

  /** Build PluginContext for plugins (used in loadConfig). Config: resolve from DI (DITokens.CONFIG). */
  private getContext(): PluginContext {
    return {
      api: this.apiClient,
      events: this.eventRouter,
    };
  }

  async loadPlugins(pluginConfigs: Array<{ name: string; enabled: boolean; config?: unknown }> = []): Promise<void> {
    const pluginConfigMap = new Map(pluginConfigs.map((p) => [p.name, p]));
    // Collect per-plugin failures so a single broken plugin doesn't
    // short-circuit the rest, but the aggregate still bubbles up to
    // bootstrap / smoke-test (DI-token regressions must not slip past).
    const failures: Array<{ source: string; error: unknown }> = [];

    const allMetadata = getAllPluginMetadata();
    for (const metadata of allMetadata) {
      try {
        await this.registerPluginFromMetadata(metadata, pluginConfigMap);
      } catch (error) {
        logger.error(`❌ [PluginManager] Failed to load plugin ${metadata.name}:`, error);
        failures.push({ source: metadata.name, error });
      }
    }

    logger.info(`📦 [PluginManager] Finished loading plugins. Total: ${this.plugins.size}`);

    if (failures.length > 0) {
      const summary = failures
        .map(({ source, error }) => `  - ${source}: ${error instanceof Error ? error.message : String(error)}`)
        .join('\n');
      const aggregate = new Error(`[PluginManager] ${failures.length} plugin(s) failed to load:\n${summary}`);
      // Preserve the underlying causes for debugging — `cause` is an array
      // because Node's stock Error.cause is a single value.
      (aggregate as Error & { causes?: unknown[] }).causes = failures.map((f) => f.error);
      throw aggregate;
    }
  }

  /**
   * Register, init, and (if enabled in config) enable a single plugin from
   * its decorator metadata. Mirrors what the previous fs-walk did per file.
   */
  private async registerPluginFromMetadata(
    metadata: PluginMetadata,
    pluginConfigMap: Map<string, { name: string; enabled: boolean; config?: unknown }>,
  ): Promise<void> {
    // LAN relay role-based filter: completely skip — no instantiation, no DI
    // side effects, no db opens. Looks at lanRelay.<role>.disabledPlugins for
    // the current instance role.
    if (this.config.isPluginDisabledByRole(metadata.name)) {
      logger.info(`⏭️  [PluginManager] Skipped plugin ${metadata.name} (disabled by lanRelay role filter)`);
      return;
    }

    // Dedupe — registry can in theory contain duplicates if a plugin file
    // is imported through multiple paths. First-wins semantics.
    if (this.plugins.has(metadata.name)) {
      return;
    }

    const PluginClass = metadata.pluginClass;
    const plugin: Plugin = new PluginClass(metadata);

    this.plugins.set(plugin.name, plugin);

    // setup plugin context and configuration
    const pluginConfig = pluginConfigMap.get(plugin.name);
    plugin.loadConfig(this.getContext(), pluginConfig);

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
      `✅ [PluginManager] Loaded plugin: ${plugin.name} v${plugin.version} (enabled: ${pluginConfig?.enabled ?? false})`,
    );
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

    if (this.running) {
      await this.startPlugin(plugin);
    }
  }

  async disablePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} not found`);
    }

    if (!this.enabledPlugins.has(name)) {
      return;
    }

    if (this.startedPlugins.has(name)) {
      await this.stopPlugin(plugin);
    }

    await plugin.onDisable?.();

    this.enabledPlugins.delete(name);
    logger.info(`⏸️ [PluginManager] Disabled plugin: ${name}`);
  }

  /**
   * Run onStart for every enabled plugin. Called once the app is connected; plugins
   * enabled after this point start as part of enablePlugin.
   */
  async startAll(): Promise<void> {
    this.running = true;
    for (const name of this.enabledPlugins) {
      const plugin = this.plugins.get(name);
      if (!plugin) {
        continue;
      }
      try {
        await this.startPlugin(plugin);
      } catch (error) {
        logger.error(`❌ [PluginManager] Failed to start plugin ${name}:`, error);
      }
    }
  }

  /** Run onStop for every started plugin, in reverse start order. */
  async stopAll(): Promise<void> {
    this.running = false;
    for (const name of [...this.startedPlugins].reverse()) {
      const plugin = this.plugins.get(name);
      if (plugin) {
        await this.stopPlugin(plugin);
      }
    }
  }

  private async startPlugin(plugin: Plugin): Promise<void> {
    await plugin.onStart?.();
    this.startedPlugins.add(plugin.name);
    logger.debug(`[PluginManager] Started plugin: ${plugin.name}`);
  }

  private async stopPlugin(plugin: Plugin): Promise<void> {
    this.startedPlugins.delete(plugin.name);
    try {
      await plugin.onStop?.();
    } catch (error) {
      logger.error(`❌ [PluginManager] Failed to stop plugin ${plugin.name}:`, error);
    }
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

  /**
   * Global enablement of one plugin — true only between a successful
   * `enablePlugin` and its `disablePlugin`. Note this is narrower than
   * "loaded": a plugin disabled in config still gets `onInit`, so its DI
   * registrations exist regardless.
   */
  isPluginEnabled(name: string): boolean {
    return this.enabledPlugins.has(name);
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
  async isPluginEnabledForConversation(pluginName: string, context: CommandContext): Promise<boolean> {
    // Check if plugin is globally enabled first
    if (!this.isPluginEnabled(pluginName)) {
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

      // Wrap with source filter when applicableSources is declared
      const allowed = hookMeta.applicableSources;
      const finalHandler: HookHandler = allowed
        ? (ctx) => {
            if (!allowed.includes(ctx.source)) {
              logger.debug(
                `[Hook] skipped due to applicableSources mismatch | plugin=${pluginName} hook=${hookMeta.hookName} source=${ctx.source}`,
              );
              return true;
            }
            return boundHandler(ctx);
          }
        : boundHandler;

      this.hookManager.addHandler(hookMeta.hookName, finalHandler, priority);
    }
  }
}
