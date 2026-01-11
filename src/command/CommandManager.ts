// Command manager - registers and manages commands

import { getTSyringeContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { getAllCommandMetadata } from './decorators';
import type {
  CommandContext,
  CommandHandler,
  CommandRegistration,
  CommandResult,
  ParsedCommand,
  PermissionLevel,
} from './types';

export interface PermissionChecker {
  checkPermission(
    userId: number,
    groupId: number | undefined,
    messageType: 'private' | 'group',
    requiredPermissions: PermissionLevel[],
    userRole?: string,
  ): boolean;
}

export class CommandManager {
  private commands = new Map<string, CommandRegistration>();
  private builtinCommands = new Map<string, CommandRegistration>();
  private hookManager: HookManager | null = null;
  private permissionChecker: PermissionChecker | null = null;

  constructor(permissionChecker?: PermissionChecker) {
    this.permissionChecker = permissionChecker || null;

    // Register self in DI container for commands that need it
    const container = getTSyringeContainer();
    container.register(DITokens.COMMAND_MANAGER, { useValue: this });

    // Auto-register all decorated commands
    this.autoRegisterDecoratedCommands();
  }

  /**
   * Set hook manager for extension hooks
   */
  setHookManager(hookManager: HookManager): void {
    this.hookManager = hookManager;
    // Register command extension hooks
    this.registerCommandHooks();
  }

  /**
   * Register command extension hooks
   */
  private registerCommandHooks(): void {
    if (!this.hookManager) {
      return;
    }

    // Register command hooks as extended hooks
    // These hooks are only available if command system is initialized
    logger.debug(
      '[CommandManager] Command extension hooks available (onCommandDetected, onCommandExecuted)',
    );
  }

  /**
   * Auto-register all decorated commands
   * Called during initialization
   */
  private autoRegisterDecoratedCommands(): void {
    const metadataList = getAllCommandMetadata();

    for (const metadata of metadataList) {
      try {
        // Check if command is enabled
        if (metadata.enabled === false) {
          logger.debug(
            `[CommandManager] Command "${metadata.name}" is disabled, skipping registration`,
          );
          continue;
        }

        // Resolve dependencies and create handler instance
        const handler = this.createHandlerInstance(metadata);

        const name = handler.name.toLowerCase();

        const registration: CommandRegistration = {
          handler,
          permissions: metadata.permissions,
          aliases: metadata.aliases,
          enabled: metadata.enabled ?? true,
        };

        this.builtinCommands.set(name, registration);
        logger.info(
          `[CommandManager] Auto-registered decorated command: ${name}`,
        );

        // Register aliases
        if (metadata.aliases) {
          for (const alias of metadata.aliases) {
            const aliasLower = alias.toLowerCase();
            this.builtinCommands.set(aliasLower, registration);
            logger.debug(
              `[CommandManager] Registered command alias: ${aliasLower} -> ${name}`,
            );
          }
        }
      } catch (error) {
        logger.error(
          `[CommandManager] Failed to auto-register command ${metadata.name}:`,
          error,
        );
      }
    }
  }

  /**
   * Create handler instance with dependency injection using TSyringe
   */
  private createHandlerInstance(metadata: {
    handlerClass: new (...args: any[]) => CommandHandler;
    name: string;
  }): CommandHandler {
    const HandlerClass = metadata.handlerClass;
    const container = getTSyringeContainer();

    // TSyringe automatically resolves dependencies using @inject() decorators
    // If the class is marked with @injectable(), container.resolve will handle dependency injection
    try {
      return container.resolve(HandlerClass);
    } catch (error) {
      // Fallback to direct instantiation if not registered with TSyringe
      // This allows for commands that don't use dependency injection
      logger.debug(
        `[CommandManager] Resolving ${metadata.name} directly (not using TSyringe)`,
      );
      return new HandlerClass();
    }
  }

  /**
   * Set permission checker
   */
  setPermissionChecker(checker: PermissionChecker): void {
    this.permissionChecker = checker;
  }

  /**
   * Check if user has required permissions
   */
  private checkPermissions(
    context: CommandContext,
    requiredPermissions?: PermissionLevel[],
  ): boolean {
    // If no permissions required, allow all users
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    // If no permission checker, allow all (backward compatibility)
    if (!this.permissionChecker) {
      logger.warn(
        '[CommandManager] No permission checker configured, allowing all commands',
      );
      return true;
    }

    // Get user role from context (if available)
    const userRole = (context.metadata?.senderRole as string) || undefined;

    return this.permissionChecker.checkPermission(
      context.userId,
      context.groupId,
      context.messageType,
      requiredPermissions,
      userRole,
    );
  }

  /**
   * Register a command handler
   */
  register(handler: CommandHandler, pluginName?: string): void {
    const name = handler.name.toLowerCase();

    if (this.commands.has(name) || this.builtinCommands.has(name)) {
      logger.warn(
        `[CommandManager] Command "${name}" already registered, overwriting...`,
      );
    }

    const registration: CommandRegistration = {
      handler,
      pluginName,
    };

    if (pluginName) {
      this.commands.set(name, registration);
      logger.info(
        `[CommandManager] Registered plugin command: ${name} (plugin: ${pluginName})`,
      );
    } else {
      this.builtinCommands.set(name, registration);
      logger.info(`[CommandManager] Registered builtin command: ${name}`);
    }
  }

  /**
   * Unregister a command
   */
  unregister(name: string, pluginName?: string): boolean {
    const lowerName = name.toLowerCase();

    if (pluginName) {
      // Unregister plugin command
      const reg = this.commands.get(lowerName);
      if (reg && reg.pluginName === pluginName) {
        this.commands.delete(lowerName);
        logger.info(
          `[CommandManager] Unregistered plugin command: ${lowerName} (plugin: ${pluginName})`,
        );
        return true;
      }
    } else {
      // Unregister builtin command
      if (this.builtinCommands.has(lowerName)) {
        this.builtinCommands.delete(lowerName);
        logger.info(
          `[CommandManager] Unregistered builtin command: ${lowerName}`,
        );
        return true;
      }
    }

    return false;
  }

  /**
   * Get command handler
   * Builtin commands have priority over plugin commands
   */
  getHandler(name: string): CommandHandler | null {
    const registration = this.getRegistration(name);
    return registration?.handler || null;
  }

  /**
   * Execute command
   * Handles command extension hooks internally
   */
  async execute(
    command: ParsedCommand,
    context: CommandContext,
    hookManager?: HookManager,
    hookContext?: HookContext,
  ): Promise<CommandResult> {
    const registration = this.getRegistration(command.name);

    if (!registration) {
      return {
        success: false,
        error: `Command "${command.name}" not found`,
      };
    }

    // Check if command is enabled
    if (registration.enabled === false) {
      return {
        success: false,
        error: `Command "${command.name}" is disabled`,
      };
    }

    // Check permissions
    if (!this.checkPermissions(context, registration.permissions)) {
      return {
        success: false,
        error: `You don't have permission to use command "${command.name}"`,
      };
    }

    const handler = registration.handler;

    // Use provided hookManager or internal one
    const hm = hookManager || this.hookManager;
    const hc: HookContext = hookContext || {
      message: {} as any,
      command,
      metadata: new Map(),
    };

    // Hook: onCommandDetected (if hook manager available)
    if (hm) {
      const shouldContinue = await hm.execute('onCommandDetected', hc);
      if (!shouldContinue) {
        return {
          success: false,
          error: 'Command execution interrupted by hook',
        };
      }
    }

    try {
      logger.debug(
        `[CommandManager] Executing command: ${command.name} with args: ${command.args.join(', ')}`,
      );

      const result = await handler.execute(command.args, context);

      // Update hook context
      hc.result = result;

      // Hook: onCommandExecuted (if hook manager available)
      if (hm) {
        await hm.execute('onCommandExecuted', hc);
      }

      if (result.success) {
        logger.debug(
          `[CommandManager] Command ${command.name} executed successfully`,
        );
      } else {
        logger.warn(
          `[CommandManager] Command ${command.name} failed: ${result.error}`,
        );
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error(
        `[CommandManager] Error executing command ${command.name}:`,
        err,
      );

      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Get command registration (includes metadata)
   */
  private getRegistration(name: string): CommandRegistration | null {
    const lowerName = name.toLowerCase();

    // Check builtin first
    const builtin = this.builtinCommands.get(lowerName);
    if (builtin) {
      return builtin;
    }

    // Check plugin commands
    const plugin = this.commands.get(lowerName);
    if (plugin) {
      return plugin;
    }

    return null;
  }

  /**
   * Get all registered commands
   * Returns commands sorted alphabetically by name
   * Builtin commands are listed before plugin commands
   */
  getAllCommands(): CommandRegistration[] {
    const all: CommandRegistration[] = [];

    // Builtin commands first
    for (const reg of this.builtinCommands.values()) {
      all.push(reg);
    }

    // Plugin commands
    for (const reg of this.commands.values()) {
      all.push(reg);
    }

    // Sort alphabetically by command name
    return all.sort((a, b) => a.handler.name.localeCompare(b.handler.name));
  }

  /**
   * Get commands by plugin
   */
  getCommandsByPlugin(pluginName: string): CommandRegistration[] {
    const result: CommandRegistration[] = [];

    for (const reg of this.commands.values()) {
      if (reg.pluginName === pluginName) {
        result.push(reg);
      }
    }

    return result;
  }

  /**
   * Unregister all commands from a plugin
   */
  unregisterPluginCommands(pluginName: string): void {
    const toRemove: string[] = [];

    for (const [name, reg] of this.commands.entries()) {
      if (reg.pluginName === pluginName) {
        toRemove.push(name);
      }
    }

    for (const name of toRemove) {
      this.commands.delete(name);
    }

    logger.info(
      `[CommandManager] Unregistered ${toRemove.length} commands from plugin: ${pluginName}`,
    );
  }
}
