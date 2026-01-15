// Builtin command handlers

import { DITokens } from '@/core/DITokens';
import type { PluginManager } from '@/plugins/PluginManager';
import { inject, injectable } from 'tsyringe';
import type { CommandManager } from '../CommandManager';
import { Command } from '../decorators';
import type { CommandHandler, CommandResult } from '../types';

/**
 * Help command - shows available commands
 */
@Command({
  name: 'help',
  description: 'Show available commands. / and ! can be used as prefix.',
  usage: '/help [command]',
  permissions: ['user'], // All users can use help
})
@injectable()
export class HelpCommand implements CommandHandler {
  name = 'help';
  description = 'Show available commands. / and ! can be used as prefix.';
  usage = '/help [command]';

  constructor(@inject(DITokens.COMMAND_MANAGER) private commandManager: CommandManager) {}

  execute(args: string[]): CommandResult {
    const commands = this.commandManager.getAllCommands();

    if (args.length > 0) {
      // Show help for specific command
      const commandName = args[0].toLowerCase();
      const command = commands.find((c) => c.handler.name === commandName);

      if (!command) {
        return {
          success: false,
          error: `Command "${commandName}" not found`,
        };
      }

      const handler = command.handler;
      let help = `Command: ${handler.name}\n`;
      if (handler.description) {
        help += `Description: ${handler.description}\n`;
      }
      if (handler.usage) {
        help += `Usage: ${handler.usage}\n`;
      }

      return {
        success: true,
        message: help,
      };
    }

    // Show all commands
    const commandList = commands
      .map((c) => {
        const handler = c.handler;
        let line = `/${handler.name}`;
        if (handler.description) {
          line += ` - ${handler.description}`;
        }
        return line;
      })
      .join('\n');

    return {
      success: true,
      message: `Available commands:\n${commandList}\n\nUse /help(!help) <command> for more info`,
    };
  }
}

/**
 * Status command - shows bot status
 */
@Command({
  name: 'status',
  description: 'Show bot status',
  usage: '/status',
  permissions: ['user'], // All users can check status
})
@injectable()
export class StatusCommand implements CommandHandler {
  name = 'status';
  description = 'Show bot status';
  usage = '/status';

  execute(): CommandResult {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const status = `Bot Status:
Uptime: ${hours}h ${minutes}m ${seconds}s
Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`;

    return {
      success: true,
      message: status,
    };
  }
}

/**
 * Ping command - responds with pong
 */
@Command({
  name: 'ping',
  description: 'Test bot response',
  usage: '/ping',
  permissions: ['user'], // All users can ping
})
@injectable()
export class PingCommand implements CommandHandler {
  name = 'ping';
  description = 'Test bot response';
  usage = '/ping';

  execute(): CommandResult {
    return {
      success: true,
      message: 'pong',
    };
  }
}

/**
 * Echo command - toggle EchoPlugin enabled/disabled state
 */
@Command({
  name: 'echo',
  description: 'Toggle EchoPlugin enabled/disabled state',
  usage: '/echo',
  permissions: ['admin'], // Only admins can toggle echo plugin
})
@injectable()
export class EchoCommand implements CommandHandler {
  name = 'echo';
  description = 'Toggle EchoPlugin enabled/disabled state';
  usage = '/echo';

  constructor(@inject(DITokens.PLUGIN_MANAGER) private pluginManager: PluginManager) {}

  async execute(): Promise<CommandResult> {
    const pluginName = 'echo';
    const plugin = this.pluginManager.getPlugin(pluginName);

    if (!plugin) {
      return {
        success: false,
        error: 'EchoPlugin not loaded',
      };
    }

    const enabledPlugins = this.pluginManager.getEnabledPlugins();
    const isEnabled = enabledPlugins.includes(pluginName);

    try {
      if (isEnabled) {
        await this.pluginManager.disablePlugin(pluginName);
        return {
          success: true,
          message: 'off',
        };
      } else {
        await this.pluginManager.enablePlugin(pluginName);
        return {
          success: true,
          message: 'on',
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `Failed to toggle plugin: ${errorMessage}`,
      };
    }
  }
}
