// Builtin command handlers

import type { AIManager } from '@/ai/AIManager';
import type { CapabilityType } from '@/ai/capabilities/types';
import { DITokens } from '@/core/DITokens';
import type { PluginManager } from '@/plugins/PluginManager';
import { inject, injectable } from 'tsyringe';
import type { CommandManager } from '../CommandManager';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

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

  constructor(@inject(DITokens.AI_MANAGER) private aiManager: AIManager) {}

  execute(_args: string[], context: CommandContext): CommandResult {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    // Get group ID
    const groupId = context.groupId !== undefined ? context.groupId.toString() : 'N/A (Private message)';

    // Get current AI providers for each capability
    const capabilities: CapabilityType[] = ['llm', 'vision', 'text2img', 'img2img'];
    const providerInfo: string[] = [];

    for (const capability of capabilities) {
      const provider = this.aiManager.getCurrentProvider(capability);
      const providerName = provider ? provider.name : 'None';
      providerInfo.push(`${capability}: ${providerName}`);
    }

    const status = `Bot Status:
Uptime: ${hours}h ${minutes}m ${seconds}s
Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
Group ID: ${groupId}
AI Providers:
  ${providerInfo.join('\n  ')}`;

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

/**
 * Command toggle command - enable or disable other commands
 * Only group admins and group owners can use this command
 * Cannot disable itself
 */
@Command({
  name: 'cmd',
  description: 'Enable or disable a command. Usage: /cmd enable <command> or /cmd disable <command>',
  usage: '/cmd enable <command> | /cmd disable <command>',
  permissions: ['group_admin', 'group_owner', 'admin'], // Only group admins, group owners, and bot admins can toggle commands
})
@injectable()
export class CommandToggleCommand implements CommandHandler {
  name = 'cmd';
  description = 'Enable or disable a command. Usage: /cmd enable <command> or /cmd disable <command>';
  usage = '/cmd enable <command> | /cmd disable <command>';

  constructor(@inject(DITokens.COMMAND_MANAGER) private commandManager: CommandManager) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    if (args.length < 2) {
      return {
        success: false,
        error: 'Usage: /cmd enable <command> or /cmd disable <command>',
      };
    }

    const action = args[0].toLowerCase();
    const commandName = args[1].toLowerCase();

    // Prevent disabling/enabling itself
    if (commandName === this.name) {
      return {
        success: false,
        error: 'Cannot enable or disable the cmd command itself',
      };
    }

    // Get command registration to check if command exists
    const allCommands = this.commandManager.getAllCommands();
    const command = allCommands.find((c) => c.handler.name.toLowerCase() === commandName);
    if (!command) {
      return {
        success: false,
        error: `Command "${commandName}" not found`,
      };
    }

    // Get group ID if in a group message
    const groupId = context.messageType === 'group' ? context.groupId : undefined;

    if (action === 'enable') {
      // Check current state for the group (or globally if not in a group)
      const isEnabled = this.commandManager.isCommandEnabled(commandName, groupId);
      if (isEnabled) {
        const location = groupId !== undefined ? `in this group` : 'globally';
        return {
          success: true,
          message: `Command "${commandName}" is already enabled ${location}`,
        };
      }

      const success = this.commandManager.enableCommand(commandName, groupId);
      if (success) {
        const location = groupId !== undefined ? `in this group` : 'globally';
        return {
          success: true,
          message: `Command "${commandName}" has been enabled ${location}`,
        };
      } else {
        return {
          success: false,
          error: `Failed to enable command "${commandName}"`,
        };
      }
    } else if (action === 'disable') {
      // Check current state for the group (or globally if not in a group)
      const isEnabled = this.commandManager.isCommandEnabled(commandName, groupId);
      if (!isEnabled) {
        const location = groupId !== undefined ? `in this group` : 'globally';
        return {
          success: true,
          message: `Command "${commandName}" is already disabled ${location}`,
        };
      }

      const success = this.commandManager.disableCommand(commandName, groupId);
      if (success) {
        const location = groupId !== undefined ? `in this group` : 'globally';
        return {
          success: true,
          message: `Command "${commandName}" has been disabled ${location}`,
        };
      } else {
        return {
          success: false,
          error: `Failed to disable command "${commandName}"`,
        };
      }
    } else {
      return {
        success: false,
        error: 'Invalid action. Use "enable" or "disable"',
      };
    }
  }
}
