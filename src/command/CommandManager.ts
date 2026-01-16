// Command manager - registers and manages commands

// import handler to register commands
import './handlers';

import { getContainer } from '@/core/DIContainer';
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
    messageType: 'private' | 'group',
    requiredPermissions: PermissionLevel[],
    userRole?: string,
  ): boolean;
}

export class CommandManager {
  private commands = new Map<string, CommandRegistration>();
  private builtinCommands = new Map<string, CommandRegistration>();
  private hookManager: HookManager | null = null;
  // Store command enabled/disabled state per group
  // Map<groupId, Map<commandName, enabled>>
  private groupCommandStates = new Map<number, Map<string, boolean>>();

  constructor(private permissionChecker: PermissionChecker) {
    this.autoRegisterDecoratedCommands();
  }

  /**
   * Set hook manager for extension hooks
   * Note: Command hooks (onCommandDetected, onCommandExecuted) are registered
   * by CommandSystem via getExtensionHooks() method, not here.
   */
  setHookManager(hookManager: HookManager): void {
    this.hookManager = hookManager;
  }

  /**
   * Auto-register all decorated commands
   * Called during initialization
   * Uses lazy instantiation - commands are created on first execution when all dependencies are available
   */
  private autoRegisterDecoratedCommands(): void {
    const metadataList = getAllCommandMetadata();

    for (const metadata of metadataList) {
      try {
        const name = metadata.name.toLowerCase();
        if (this.builtinCommands.has(name)) {
          continue;
        }

        // Create a lazy handler that will instantiate the command on first execution
        const lazyHandler = this.createLazyHandler(metadata);

        // Register all commands regardless of enabled state
        // The enabled state from decorator is used as initial state, but commands can be
        // enabled/disabled at runtime via /cmd enable/disable
        const registration: CommandRegistration = {
          handler: lazyHandler,
          handlerClass: metadata.handlerClass, // Store class reference for lazy instantiation
          permissions: metadata.permissions,
          aliases: metadata.aliases,
          enabled: metadata.enabled ?? true, // Use decorator's enabled state as initial state
        };

        this.builtinCommands.set(name, registration);
        const enabledStatus = registration.enabled ? 'enabled' : 'disabled';
        logger.info(
          `[CommandManager] Auto-registered decorated command: ${name} (lazy instantiation, initially ${enabledStatus})`,
        );

        // Register aliases
        if (metadata.aliases) {
          for (const alias of metadata.aliases) {
            const aliasLower = alias.toLowerCase();
            // Also check if alias is already registered
            if (!this.builtinCommands.has(aliasLower)) {
              this.builtinCommands.set(aliasLower, registration);
              logger.debug(`[CommandManager] Registered command alias: ${aliasLower} -> ${name}`);
            } else {
              logger.debug(`[CommandManager] Command alias "${aliasLower}" already registered, skipping`);
            }
          }
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Unknown error');
        logger.error(`[CommandManager] Failed to auto-register command ${metadata.name}:`, err);
        logger.error(`[CommandManager] Error details: ${err.message}\n${err.stack}`);
      }
    }
  }

  /**
   * Create a lazy handler that instantiates the command on first execution
   * Uses Proxy API for complete property and method delegation
   * This ensures all properties and methods are properly proxied, even if CommandHandler interface extends
   */
  private createLazyHandler(metadata: {
    handlerClass: new (...args: any[]) => CommandHandler;
    name: string;
    description?: string;
    usage?: string;
  }): CommandHandler {
    const HandlerClass = metadata.handlerClass;
    let cachedInstance: CommandHandler | null = null;

    // Helper function to get or create the instance
    const getInstance = (): CommandHandler => {
      if (cachedInstance) {
        return cachedInstance;
      }

      const container = getContainer();

      // Try to resolve with dependency injection
      try {
        cachedInstance = container.resolve(HandlerClass);
        logger.debug(`[CommandManager] Lazy-instantiated ${metadata.name} with dependency injection`);
        return cachedInstance;
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Unknown error');
        // Only fallback for commands that truly don't need DI (no constructor params)
        // Otherwise, log error and rethrow to surface dependency issues
        if (HandlerClass.length === 0) {
          logger.debug(
            `[CommandManager] Falling back to direct instantiation for ${metadata.name} (no constructor params)`,
          );
          cachedInstance = new HandlerClass();
          return cachedInstance;
        }

        // If command has constructor params but DI failed, this is a real error
        logger.error(`[CommandManager] Failed to resolve ${metadata.name} with DI: ${err.message}`);
        throw new Error(`Failed to instantiate command ${metadata.name}: ${err.message}`);
      }
    };

    // Use Proxy for complete delegation
    // This handles all properties and methods, even if CommandHandler interface extends
    return new Proxy({} as CommandHandler, {
      get(target, prop) {
        // For known metadata properties, return from metadata first to avoid instantiation
        if (prop in metadata) {
          return (metadata as any)[prop];
        }

        // For all other properties/methods, delegate to actual instance
        const instance = getInstance();
        const value = instance[prop as keyof CommandHandler];

        // Bind methods to preserve 'this' context
        if (typeof value === 'function') {
          return value.bind(instance);
        }

        return value;
      },

      // Support 'in' operator
      has(target, prop) {
        const instance = getInstance();
        return prop in instance;
      },

      // Support Object.keys() and similar operations
      ownKeys(target) {
        const instance = getInstance();
        return Reflect.ownKeys(instance);
      },

      // Support property descriptor access
      getOwnPropertyDescriptor(target, prop) {
        const instance = getInstance();
        return Reflect.getOwnPropertyDescriptor(instance, prop);
      },
    });
  }

  /**
   * Check if user has required permissions
   */
  private checkPermissions(context: CommandContext, requiredPermissions?: PermissionLevel[]): boolean {
    // If no permissions required, allow all users
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    // Get user role from context (if available)
    const userRole = (context.metadata?.senderRole as string) || undefined;

    return this.permissionChecker.checkPermission(context.userId, context.messageType, requiredPermissions, userRole);
  }

  /**
   * Register a command handler
   */
  register(handler: CommandHandler, pluginName?: string): void {
    const name = handler.name.toLowerCase();

    if (this.commands.has(name) || this.builtinCommands.has(name)) {
      logger.warn(`[CommandManager] Command "${name}" already registered, overwriting...`);
    }

    const registration: CommandRegistration = {
      handler,
      pluginName,
    };

    if (pluginName) {
      this.commands.set(name, registration);
      logger.info(`[CommandManager] Registered plugin command: ${name} (plugin: ${pluginName})`);
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
        logger.info(`[CommandManager] Unregistered plugin command: ${lowerName} (plugin: ${pluginName})`);
        return true;
      }
    } else {
      // Unregister builtin command
      if (this.builtinCommands.has(lowerName)) {
        this.builtinCommands.delete(lowerName);
        logger.info(`[CommandManager] Unregistered builtin command: ${lowerName}`);
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
    hookManager: HookManager,
    hookContext: HookContext,
  ): Promise<CommandResult> {
    const registration = this.getRegistration(command.name);

    if (!registration) {
      logger.warn(
        `[CommandManager] Command "${command.name}" not found | available commands: ${Array.from(this.builtinCommands.keys()).join(', ')}`,
      );
      return {
        success: false,
        error: `Command "${command.name}" not found`,
      };
    }

    // Check permissions first - if user doesn't have permission, return permission error
    // This ensures that disabled commands return "no permission" error for users without permission
    const userRole = (context.metadata?.senderRole as string) || undefined;
    const hasPermission = this.checkPermissions(context, registration.permissions);
    if (!hasPermission) {
      return {
        success: false,
        error: `You don't have permission to use command "${command.name}"`,
      };
    }

    // Check if user is admin - admins can always execute commands regardless of enabled state
    const isAdmin = this.permissionChecker.checkPermission(context.userId, context.messageType, ['admin'], userRole);

    // Check if command is enabled (skip for admins)
    if (!isAdmin) {
      let isEnabled = registration.enabled ?? true; // Default to enabled if not set

      // For group messages, check group-specific state first
      if (context.messageType === 'group' && context.groupId !== undefined) {
        const groupStates = this.groupCommandStates.get(context.groupId);
        if (groupStates) {
          const commandState = groupStates.get(command.name.toLowerCase());
          // If explicitly set in this group, use group state; otherwise use global state
          if (commandState !== undefined) {
            isEnabled = commandState;
          }
        }
      }

      if (!isEnabled) {
        const location = context.messageType === 'group' ? 'in this group' : 'globally';
        return {
          success: false,
          error: `Command "${command.name}" is disabled ${location}`,
        };
      }
    }

    // Hook: onCommandDetected (if hook manager available)
    const shouldContinue = await hookManager.execute('onCommandDetected', hookContext);
    if (!shouldContinue) {
      return {
        success: false,
        error: 'Command execution interrupted by hook',
      };
    }

    try {
      logger.debug(`[CommandManager] Executing command: ${command.name} with args: ${command.args.join(', ')}`);

      const result = await registration.handler.execute(command.args, context);

      // Update hook context
      hookContext.result = result;

      // Hook: onCommandExecuted (if hook manager available)
      await hookManager.execute('onCommandExecuted', hookContext);

      if (result.success) {
        logger.debug(`[CommandManager] Command ${command.name} executed successfully`);
      } else {
        logger.warn(`[CommandManager] Command ${command.name} failed: ${result.error}`);
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error(`[CommandManager] Error executing command ${command.name}:`, err);

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
    // Use WeakSet to deduplicate by registration object reference
    // This prevents aliases from appearing as separate commands
    const seenRegistrations = new WeakSet<CommandRegistration>();

    // Builtin commands first
    for (const reg of this.builtinCommands.values()) {
      // Only add each registration object once, even if it's referenced by multiple keys (aliases)
      if (!seenRegistrations.has(reg)) {
        seenRegistrations.add(reg);
        all.push(reg);
      }
    }

    // Plugin commands
    for (const reg of this.commands.values()) {
      if (!seenRegistrations.has(reg)) {
        seenRegistrations.add(reg);
        all.push(reg);
      }
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

    logger.info(`[CommandManager] Unregistered ${toRemove.length} commands from plugin: ${pluginName}`);
  }

  /**
   * Enable a command
   * @param name - Command name to enable
   * @param groupId - Optional group ID to enable command for specific group. If not provided, enables globally
   * @returns true if command was found and enabled, false otherwise
   */
  enableCommand(name: string, groupId?: number): boolean {
    const registration = this.getRegistration(name);
    if (!registration) {
      logger.warn(`[CommandManager] Cannot enable command "${name}": command not found`);
      return false;
    }

    if (groupId !== undefined) {
      // Enable for specific group
      let groupStates = this.groupCommandStates.get(groupId);
      if (!groupStates) {
        groupStates = new Map<string, boolean>();
        this.groupCommandStates.set(groupId, groupStates);
      }
      groupStates.set(name.toLowerCase(), true);
      logger.info(`[CommandManager] Enabled command "${name}" for group ${groupId}`);
    } else {
      // Enable globally
      registration.enabled = true;
      logger.info(`[CommandManager] Enabled command: ${name} (globally)`);
    }
    return true;
  }

  /**
   * Disable a command
   * @param name - Command name to disable
   * @param groupId - Optional group ID to disable command for specific group. If not provided, disables globally
   * @returns true if command was found and disabled, false otherwise
   */
  disableCommand(name: string, groupId?: number): boolean {
    const registration = this.getRegistration(name);
    if (!registration) {
      logger.warn(`[CommandManager] Cannot disable command "${name}": command not found`);
      return false;
    }

    if (groupId !== undefined) {
      // Disable for specific group
      let groupStates = this.groupCommandStates.get(groupId);
      if (!groupStates) {
        groupStates = new Map<string, boolean>();
        this.groupCommandStates.set(groupId, groupStates);
      }
      groupStates.set(name.toLowerCase(), false);
      logger.info(`[CommandManager] Disabled command "${name}" for group ${groupId}`);
    } else {
      // Disable globally
      registration.enabled = false;
      logger.info(`[CommandManager] Disabled command: ${name} (globally)`);
    }
    return true;
  }

  /**
   * Check if a command is enabled for a specific group
   * @param name - Command name to check
   * @param groupId - Group ID to check (optional, for group messages)
   * @returns true if command is enabled, false otherwise
   */
  isCommandEnabled(name: string, groupId?: number): boolean {
    const registration = this.getRegistration(name);
    if (!registration) {
      return false;
    }

    let isEnabled = registration.enabled ?? true; // Default to enabled if not set

    // If group ID is provided, check group-specific state
    if (groupId !== undefined) {
      const groupStates = this.groupCommandStates.get(groupId);
      if (groupStates) {
        const commandState = groupStates.get(name.toLowerCase());
        // If explicitly set in this group, use group state; otherwise use global state
        if (commandState !== undefined) {
          isEnabled = commandState;
        }
      }
    }

    return isEnabled;
  }

  /**
   * Check if a command exists
   * @param name - Command name to check
   * @returns true if command exists, false otherwise
   */
  hasCommand(name: string): boolean {
    return this.getRegistration(name) !== null;
  }
}
