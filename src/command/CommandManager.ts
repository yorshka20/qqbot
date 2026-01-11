// Command manager - registers and manages commands

import type {
  CommandHandler,
  CommandRegistration,
  CommandContext,
  CommandResult,
  ParsedCommand,
} from './types';
import { logger } from '@/utils/logger';

export class CommandManager {
  private commands = new Map<string, CommandRegistration>();
  private builtinCommands = new Map<string, CommandRegistration>();

  /**
   * Register a command handler
   */
  register(
    handler: CommandHandler,
    priority = 0,
    pluginName?: string,
  ): void {
    const name = handler.name.toLowerCase();

    if (this.commands.has(name) || this.builtinCommands.has(name)) {
      logger.warn(
        `[CommandManager] Command "${name}" already registered, overwriting...`,
      );
    }

    const registration: CommandRegistration = {
      handler,
      priority,
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
    const lowerName = name.toLowerCase();

    // Check builtin first
    const builtin = this.builtinCommands.get(lowerName);
    if (builtin) {
      return builtin.handler;
    }

    // Check plugin commands
    const plugin = this.commands.get(lowerName);
    if (plugin) {
      return plugin.handler;
    }

    return null;
  }

  /**
   * Execute command
   */
  async execute(
    command: ParsedCommand,
    context: CommandContext,
  ): Promise<CommandResult> {
    const handler = this.getHandler(command.name);

    if (!handler) {
      return {
        success: false,
        error: `Command "${command.name}" not found`,
      };
    }

    try {
      logger.debug(
        `[CommandManager] Executing command: ${command.name} with args: ${command.args.join(', ')}`,
      );

      const result = await handler.execute(command.args, context);

      if (result.success) {
        logger.debug(`[CommandManager] Command ${command.name} executed successfully`);
      } else {
        logger.warn(
          `[CommandManager] Command ${command.name} failed: ${result.error}`,
        );
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
   * Get all registered commands
   */
  getAllCommands(): CommandRegistration[] {
    const all: CommandRegistration[] = [];

    // Builtin commands first (higher priority)
    for (const reg of this.builtinCommands.values()) {
      all.push(reg);
    }

    // Plugin commands
    for (const reg of this.commands.values()) {
      all.push(reg);
    }

    // Sort by priority (higher first)
    return all.sort((a, b) => b.priority - a.priority);
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
