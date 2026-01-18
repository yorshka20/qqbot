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
 * Command usage strings
 */
const USAGE = {
  MAIN: '/cmd enable <command> [command2] ... [--global] | /cmd disable <command> [command2] ... [--global] | /cmd plugin enable <plugin> [--global] | /cmd plugin disable <plugin> [--global]',
  COMMAND: '/cmd enable <command> [command2] [command3] ... [--global] | /cmd disable <command> [command2] [command3] ... [--global]',
  PLUGIN: '/cmd plugin enable <plugin> [--global] | /cmd plugin disable <plugin> [--global]',
} as const;

/**
 * Action type for enable/disable operations
 */
type Action = 'enable' | 'disable';

/**
 * Result of processing a single command/plugin
 */
interface ProcessResult {
  name: string;
  success: boolean;
  error?: string;
  alreadyInState?: boolean;
}

/**
 * Location description for configuration scope
 */
interface LocationDescription {
  location: string;
  isGlobal: boolean;
}

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

    const cmdHandler = new PluginCommandHandler(
      'cmd',
      `Enable or disable commands and plugins. Usage: ${USAGE.MAIN}`,
      USAGE.MAIN,
      async (args: string[], context: CommandContext) => {
        return await this.executeCmdCommand(args, context);
      },
      this.context,
    );

    this.commandManager.register(cmdHandler, this.name);

    const registration = this.commandManager.getRegistration('cmd');
    if (registration) {
      registration.permissions = ['group_admin', 'group_owner', 'admin'];
    }

    logger.info('[ConversationConfigPlugin] Registered /cmd command');
  }

  async onDisable(): Promise<void> {
    await super.onDisable();
    logger.info('[ConversationConfigPlugin] Disabling conversation config plugin');

    this.commandManager.unregister('cmd', this.name);
    logger.info('[ConversationConfigPlugin] Unregistered /cmd command');
  }

  /**
   * Execute /cmd command
   */
  private async executeCmdCommand(args: string[], context: CommandContext): Promise<CommandResult> {
    if (args.length < 2) {
      return this.createErrorResult(USAGE.MAIN);
    }

    const isGlobal = args.includes('--global');
    const filteredArgs = args.filter((arg) => arg !== '--global');

    // Handle plugin subcommand
    if (filteredArgs[0]?.toLowerCase() === 'plugin') {
      return await this.handlePluginCommand(filteredArgs.slice(1), context, isGlobal);
    }

    // Handle command enable/disable
    return await this.handleCommandCommand(filteredArgs, context, isGlobal);
  }

  /**
   * Handle command enable/disable operations (supports multiple commands)
   */
  private async handleCommandCommand(
    args: string[],
    context: CommandContext,
    isGlobal: boolean,
  ): Promise<CommandResult> {
    // Validate arguments
    const validationResult = this.validateCommandArgs(args);
    if (!validationResult.valid || !validationResult.action || !validationResult.names) {
      return this.createErrorResult(validationResult.error || USAGE.COMMAND);
    }

    const { action, names: commandNames } = validationResult;

    // Validate command names
    const nameValidation = this.validateCommandNames(commandNames);
    if (!nameValidation.valid) {
      return this.createErrorResult(nameValidation.error || '');
    }

    // Get session info
    const sessionId = getSessionId(context);
    const sessionType = getSessionType(context);
    const locationDesc = this.getLocationDescription(context, isGlobal);

    // Process each command
    const results = await this.processCommands(commandNames, action, sessionId, sessionType, isGlobal);

    // Build response message
    return this.buildCommandResponse(results, action, locationDesc, commandNames.length === 1);
  }

  /**
   * Handle plugin enable/disable operations
   */
  private async handlePluginCommand(
    args: string[],
    context: CommandContext,
    isGlobal: boolean,
  ): Promise<CommandResult> {
    if (args.length < 2) {
      return this.createErrorResult(USAGE.PLUGIN);
    }

    const action = args[0]?.toLowerCase() as Action;
    if (action !== 'enable' && action !== 'disable') {
      return this.createErrorResult('Invalid action. Use "enable" or "disable"');
    }

    const pluginName = args[1]?.toLowerCase();
    if (!pluginName) {
      return this.createErrorResult(USAGE.PLUGIN);
    }

    // Check if plugin exists
    const plugin = this.pluginManager.getPlugin(pluginName);
    if (!plugin) {
      return this.createErrorResult(`Plugin "${pluginName}" not found`);
    }

    // Check current state
    const isEnabled = await this.pluginManager.isPluginEnabledForConversation(pluginName, context);
    const locationDesc = this.getLocationDescription(context, isGlobal);

    if (action === 'enable') {
      if (isEnabled && !isGlobal) {
        return this.createSuccessResult(`Plugin "${pluginName}" is already enabled ${locationDesc.location}`);
      }

      await this.pluginManager.enablePluginForConversation(pluginName, context, isGlobal);
      return this.createSuccessResult(`Plugin "${pluginName}" has been enabled ${locationDesc.location}`);
    } else {
      // disable
      if (!isEnabled && !isGlobal) {
        return this.createSuccessResult(`Plugin "${pluginName}" is already disabled ${locationDesc.location}`);
      }

      await this.pluginManager.disablePluginForConversation(pluginName, context, isGlobal);
      return this.createSuccessResult(`Plugin "${pluginName}" has been disabled ${locationDesc.location}`);
    }
  }

  /**
   * Validate command arguments
   */
  private validateCommandArgs(args: string[]): {
    valid: boolean;
    action?: Action;
    names?: string[];
    error?: string;
  } {
    if (args.length < 2) {
      return { valid: false, error: USAGE.COMMAND };
    }

    const action = args[0]?.toLowerCase() as Action;
    if (action !== 'enable' && action !== 'disable') {
      return { valid: false, error: 'Invalid action. Use "enable" or "disable"' };
    }

    const names = args.slice(1).filter((name) => name.trim().length > 0);
    if (names.length === 0) {
      return { valid: false, error: 'At least one command name is required' };
    }

    return { valid: true, action, names };
  }

  /**
   * Validate command names
   */
  private validateCommandNames(commandNames: string[]): { valid: boolean; error?: string } {
    if (commandNames.some((name) => name.toLowerCase() === 'cmd')) {
      return { valid: false, error: 'Cannot enable or disable the cmd command itself' };
    }

    return { valid: true };
  }

  /**
   * Process multiple commands
   */
  private async processCommands(
    commandNames: string[],
    action: Action,
    sessionId: string,
    sessionType: 'user' | 'group',
    isGlobal: boolean,
  ): Promise<ProcessResult[]> {
    const results: ProcessResult[] = [];

    for (const commandName of commandNames) {
      const normalizedName = commandName.toLowerCase();

      // Check if command exists
      const allCommands = this.commandManager.getAllCommands();
      const command = allCommands.find((c) => c.handler.name.toLowerCase() === normalizedName);
      if (!command) {
        results.push({
          name: normalizedName,
          success: false,
          error: `Command "${normalizedName}" not found`,
        });
        continue;
      }

      // Process command
      const result = await this.processSingleCommand(normalizedName, action, sessionId, sessionType, isGlobal);
      results.push(result);
    }

    return results;
  }

  /**
   * Process a single command
   */
  private async processSingleCommand(
    commandName: string,
    action: Action,
    sessionId: string,
    sessionType: 'user' | 'group',
    isGlobal: boolean,
  ): Promise<ProcessResult> {
    const isEnabled = await this.commandManager.isCommandEnabled(commandName, sessionId, sessionType);

    if (action === 'enable') {
      if (isEnabled && !isGlobal) {
        return {
          name: commandName,
          success: true,
          alreadyInState: true,
        };
      }

      const success = await this.commandManager.enableCommand(commandName, sessionId, sessionType, isGlobal);
      return {
        name: commandName,
        success,
        error: success ? undefined : `Failed to enable command "${commandName}"`,
      };
    } else {
      // disable
      if (!isEnabled && !isGlobal) {
        return {
          name: commandName,
          success: true,
          alreadyInState: true,
        };
      }

      const success = await this.commandManager.disableCommand(commandName, sessionId, sessionType, isGlobal);
      return {
        name: commandName,
        success,
        error: success ? undefined : `Failed to disable command "${commandName}"`,
      };
    }
  }

  /**
   * Build response message for command operations
   */
  private buildCommandResponse(
    results: ProcessResult[],
    action: Action,
    locationDesc: LocationDescription,
    isSingleCommand: boolean,
  ): CommandResult {
    const messageBuilder = new MessageBuilder();
    const successCount = results.filter((r) => r.success && !r.alreadyInState).length;
    const alreadyCount = results.filter((r) => r.alreadyInState).length;
    const failCount = results.filter((r) => !r.success).length;

    if (isSingleCommand) {
      // Single command - detailed message
      const result = results[0]!;
      if (result.alreadyInState) {
        messageBuilder.text(`Command "${result.name}" is already ${action}d ${locationDesc.location}`);
      } else if (result.success) {
        messageBuilder.text(`Command "${result.name}" has been ${action}d ${locationDesc.location}`);
      } else {
        return this.createErrorResult(result.error || `Failed to ${action} command "${result.name}"`);
      }
    } else {
      // Multiple commands - summary message
      const parts: string[] = [];
      if (successCount > 0) {
        parts.push(`${successCount} command(s) ${action}d`);
      }
      if (alreadyCount > 0) {
        parts.push(`${alreadyCount} command(s) already ${action}d`);
      }
      if (failCount > 0) {
        parts.push(`${failCount} command(s) failed`);
      }

      messageBuilder.text(`${parts.join(', ')} ${locationDesc.location}`);

      // Add details for failed commands
      const failedCommands = results.filter((r) => !r.success);
      if (failedCommands.length > 0) {
        const failedNames = failedCommands.map((r) => `"${r.name}"`).join(', ');
        messageBuilder.text(`\nFailed: ${failedNames}`);
      }
    }

    return {
      success: failCount === 0,
      segments: messageBuilder.build(),
    };
  }

  /**
   * Get location description for configuration scope
   */
  private getLocationDescription(context: CommandContext, isGlobal: boolean): LocationDescription {
    if (isGlobal) {
      return {
        location: 'globally (not persisted, reset on restart)',
        isGlobal: true,
      };
    }

    return {
      location: context.messageType === 'group' ? 'in this conversation' : 'in this conversation',
      isGlobal: false,
    };
  }

  /**
   * Create error result
   */
  private createErrorResult(error: string): CommandResult {
    return {
      success: false,
      error,
    };
  }

  /**
   * Create success result with message
   */
  private createSuccessResult(message: string): CommandResult {
    const messageBuilder = new MessageBuilder();
    messageBuilder.text(message);
    return {
      success: true,
      segments: messageBuilder.build(),
    };
  }
}
