// Conversation Config Plugin - manages conversation-level configuration
// Provides commands to enable/disable commands and plugins per conversation

import type { CommandManager } from '@/command/CommandManager';
import type { CommandContext, CommandResult } from '@/command/types';
import { getSessionId, getSessionType } from '@/config/SessionUtils';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { Plugin } from '@/plugins/decorators';
import { PluginBase } from '@/plugins/PluginBase';
import { PluginCommandHandler } from '@/plugins/PluginCommandHandler';
import type { PluginManager } from '@/plugins/PluginManager';
import { logger } from '@/utils/logger';

/**
 * Conversation Config Plugin
 * Manages conversation-level configuration
 * Provides /cmd command to enable/disable commands and plugins
 */
@Plugin({
  name: 'conversationConfig',
  version: '1.0.0',
  description: 'Manages conversation-level configuration',
})
export class ConversationConfigPlugin extends PluginBase {
  private commandManager!: CommandManager;
  private pluginManager!: PluginManager;

  async onInit(): Promise<void> {
    // Get CommandManager and PluginManager from DI container
    const container = getContainer();
    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);
    this.pluginManager = container.resolve<PluginManager>(DITokens.PLUGIN_MANAGER);

    if (!this.commandManager) {
      throw new Error('[ConversationConfigPlugin] CommandManager not found');
    }

    if (!this.pluginManager) {
      throw new Error('[ConversationConfigPlugin] PluginManager not found');
    }
  }

  async onEnable(): Promise<void> {
    await super.onEnable();
    logger.info('[ConversationConfigPlugin] Enabling conversation config plugin');

    // Register /cmd command with permissions
    // PluginCommandHandler requires executeFn signature: (args, context, pluginContext)
    const cmdHandler = new PluginCommandHandler(
      'cmd',
      'Enable or disable commands and plugins. Usage: /cmd enable <command> [--global] | /cmd disable <command> [--global] | /cmd plugin enable <plugin> [--global] | /cmd plugin disable <plugin> [--global]',
      '/cmd enable <command> [--global] | /cmd disable <command> [--global] | /cmd plugin enable <plugin> [--global] | /cmd plugin disable <plugin> [--global]',
      async (args: string[], context: CommandContext, pluginContext) => {
        // pluginContext is available but not used in this implementation
        return await this.executeCmdCommand(args, context);
      },
      this.context,
    );

    // Register command
    this.commandManager.register(cmdHandler, this.name);

    // Set permissions after registration (group_admin, group_owner, admin)
    const registration = this.commandManager.getRegistration('cmd');
    if (registration) {
      registration.permissions = ['group_admin', 'group_owner', 'admin'];
    }
    logger.info('[ConversationConfigPlugin] Registered /cmd command');
  }

  async onDisable(): Promise<void> {
    await super.onDisable();
    logger.info('[ConversationConfigPlugin] Disabling conversation config plugin');

    // Unregister /cmd command
    this.commandManager.unregister('cmd', this.name);
    logger.info('[ConversationConfigPlugin] Unregistered /cmd command');
  }

  /**
   * Execute /cmd command
   */
  private async executeCmdCommand(
    args: string[],
    context: CommandContext,
  ): Promise<CommandResult> {
    if (args.length < 2) {
      return {
        success: false,
        error:
          'Usage: /cmd enable <command> [--global] | /cmd disable <command> [--global] | /cmd plugin enable <plugin> [--global] | /cmd plugin disable <plugin> [--global]',
      };
    }

    // Check for --global flag
    const isGlobal = args.includes('--global');
    const filteredArgs = args.filter((arg) => arg !== '--global');

    // Handle plugin subcommand
    if (filteredArgs[0]?.toLowerCase() === 'plugin') {
      return await this.handlePluginCommand(filteredArgs.slice(1), context, isGlobal);
    }

    // Handle command enable/disable
    return await this.handleCommandCommand(filteredArgs, context, isGlobal);
  }

  private async handleCommandCommand(
    args: string[],
    context: CommandContext,
    isGlobal: boolean,
  ): Promise<CommandResult> {
    if (args.length < 2) {
      return {
        success: false,
        error: 'Usage: /cmd enable <command> [--global] | /cmd disable <command> [--global]',
      };
    }

    const action = args[0].toLowerCase();
    const commandName = args[1].toLowerCase();

    // Prevent disabling/enabling itself
    if (commandName === 'cmd') {
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

    // Get session info (handles private, group, and temp sessions correctly)
    const sessionId = getSessionId(context);
    const sessionType = getSessionType(context);

    const messageBuilder = new MessageBuilder();

    if (action === 'enable') {
      // Check current state
      const isEnabled = await this.commandManager.isCommandEnabled(commandName, sessionId, sessionType);
      if (isEnabled && !isGlobal) {
        const location = context.messageType === 'group' ? 'in this conversation' : 'in this conversation';
        messageBuilder.text(`Command "${commandName}" is already enabled ${location}`);
        return {
          success: true,
          segments: messageBuilder.build(),
        };
      }

      const success = await this.commandManager.enableCommand(commandName, sessionId, sessionType, isGlobal);
      if (success) {
        const location = isGlobal
          ? 'globally (not persisted, reset on restart)'
          : context.messageType === 'group'
            ? 'in this conversation'
            : 'in this conversation';
        messageBuilder.text(`Command "${commandName}" has been enabled ${location}`);
        return {
          success: true,
          segments: messageBuilder.build(),
        };
      } else {
        return {
          success: false,
          error: `Failed to enable command "${commandName}"`,
        };
      }
    } else if (action === 'disable') {
      // Check current state
      const isEnabled = await this.commandManager.isCommandEnabled(commandName, sessionId, sessionType);
      if (!isEnabled && !isGlobal) {
        const location = context.messageType === 'group' ? 'in this conversation' : 'in this conversation';
        messageBuilder.text(`Command "${commandName}" is already disabled ${location}`);
        return {
          success: true,
          segments: messageBuilder.build(),
        };
      }

      const success = await this.commandManager.disableCommand(commandName, sessionId, sessionType, isGlobal);
      if (success) {
        const location = isGlobal
          ? 'globally (not persisted, reset on restart)'
          : context.messageType === 'group'
            ? 'in this conversation'
            : 'in this conversation';
        messageBuilder.text(`Command "${commandName}" has been disabled ${location}`);
        return {
          success: true,
          segments: messageBuilder.build(),
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

  private async handlePluginCommand(
    args: string[],
    context: CommandContext,
    isGlobal: boolean,
  ): Promise<CommandResult> {
    if (args.length < 2) {
      return {
        success: false,
        error: 'Usage: /cmd plugin enable <plugin> [--global] | /cmd plugin disable <plugin> [--global]',
      };
    }

    const action = args[0].toLowerCase();
    const pluginName = args[1].toLowerCase();

    // Check if plugin exists
    const plugin = this.pluginManager.getPlugin(pluginName);
    if (!plugin) {
      return {
        success: false,
        error: `Plugin "${pluginName}" not found`,
      };
    }

    const messageBuilder = new MessageBuilder();

    if (action === 'enable') {
      // Check current state
      const isEnabled = await this.pluginManager.isPluginEnabledForConversation(pluginName, context);
      if (isEnabled && !isGlobal) {
        const location = context.messageType === 'group' ? 'in this conversation' : 'in this conversation';
        messageBuilder.text(`Plugin "${pluginName}" is already enabled ${location}`);
        return {
          success: true,
          segments: messageBuilder.build(),
        };
      }

      await this.pluginManager.enablePluginForConversation(pluginName, context, isGlobal);
      const location = isGlobal
        ? 'globally (not persisted, reset on restart)'
        : context.messageType === 'group'
          ? 'in this conversation'
          : 'in this conversation';
      messageBuilder.text(`Plugin "${pluginName}" has been enabled ${location}`);
      return {
        success: true,
        segments: messageBuilder.build(),
      };
    } else if (action === 'disable') {
      // Check current state
      const isEnabled = await this.pluginManager.isPluginEnabledForConversation(pluginName, context);
      if (!isEnabled && !isGlobal) {
        const location = context.messageType === 'group' ? 'in this conversation' : 'in this conversation';
        messageBuilder.text(`Plugin "${pluginName}" is already disabled ${location}`);
        return {
          success: true,
          segments: messageBuilder.build(),
        };
      }

      await this.pluginManager.disablePluginForConversation(pluginName, context, isGlobal);
      const location = isGlobal
        ? 'globally (not persisted, reset on restart)'
        : context.messageType === 'group'
          ? 'in this conversation'
          : 'in this conversation';
      messageBuilder.text(`Plugin "${pluginName}" has been disabled ${location}`);
      return {
        success: true,
        segments: messageBuilder.build(),
      };
    } else {
      return {
        success: false,
        error: 'Invalid action. Use "enable" or "disable"',
      };
    }
  }
}
