// Builtin command handlers

import type { AIManager } from '@/ai/AIManager';
import type { CapabilityType } from '@/ai/capabilities/types';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { ProactiveConversationService } from '@/conversation/proactive';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { PluginManager } from '@/plugins/PluginManager';
import { inject, injectable } from 'tsyringe';
import type { CommandManager } from '../CommandManager';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

/** Template name for trigger words: preference.{preferenceKey}.trigger (prompts/preference/{key}/trigger.txt). */
const TRIGGER_TEMPLATE_SUFFIX = '.trigger';

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

  constructor(@inject(DITokens.COMMAND_MANAGER) private commandManager: CommandManager) { }

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

      const messageBuilder = new MessageBuilder();
      messageBuilder.text(help);
      return {
        success: true,
        segments: messageBuilder.build(),
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

    const messageBuilder = new MessageBuilder();
    messageBuilder.text(`Available commands:\n${commandList}\n\nUse /help(!help) <command> for more info`);
    return {
      success: true,
      segments: messageBuilder.build(),
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

  constructor(@inject(DITokens.AI_MANAGER) private aiManager: AIManager) { }

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

    const messageBuilder = new MessageBuilder();
    messageBuilder.text(status);
    return {
      success: true,
      segments: messageBuilder.build(),
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
    const messageBuilder = new MessageBuilder();
    messageBuilder.text('pong');
    return {
      success: true,
      segments: messageBuilder.build(),
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

  constructor(@inject(DITokens.PLUGIN_MANAGER) private pluginManager: PluginManager) { }

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
      const messageBuilder = new MessageBuilder();
      if (isEnabled) {
        await this.pluginManager.disablePlugin(pluginName);
        messageBuilder.text('off');
      } else {
        await this.pluginManager.enablePlugin(pluginName);
        messageBuilder.text('on');
      }
      return {
        success: true,
        segments: messageBuilder.build(),
      };
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
 * Role command - show current group's proactive preference config (preferenceKeys and trigger words)
 */
@Command({
  name: 'role',
  description: 'Show proactive preferences and trigger words configured for this group',
  usage: '/role',
  permissions: ['user'],
})
@injectable()
export class RoleCommand implements CommandHandler {
  name = 'role';
  description = 'Show proactive preferences and trigger words configured for this group';
  usage = '/role';

  constructor(
    @inject(DITokens.PROACTIVE_CONVERSATION_SERVICE) private proactiveConversationService: ProactiveConversationService,
    @inject(DITokens.PROMPT_MANAGER) private promptManager: PromptManager,
  ) { }

  execute(_args: string[], context: CommandContext): CommandResult {
    if (context.messageType !== 'group' || context.groupId === undefined) {
      return {
        success: false,
        error: '仅支持在群内使用 /role',
      };
    }

    const groupId = context.groupId.toString();
    const preferenceKeys = this.proactiveConversationService.getGroupPreferenceKeys(groupId);

    if (preferenceKeys.length === 0) {
      const messageBuilder = new MessageBuilder();
      messageBuilder.text('当前群未配置 proactive 偏好。');
      return {
        success: true,
        segments: messageBuilder.build(),
      };
    }

    const lines: string[] = ['当前群启用的偏好 (preference) 与触发词：', ''];

    for (const key of preferenceKeys) {
      lines.push(`【${key}】`);
      const templateName = `${key}${TRIGGER_TEMPLATE_SUFFIX}`;
      const template = this.promptManager.getTemplate(templateName);
      const triggerWords =
        template?.content
          ?.split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith('#')) ?? [];
      if (triggerWords.length > 0) {
        lines.push(`  触发词: ${triggerWords.join('、')}`);
      } else {
        lines.push('  触发词: (无，仅按消息条数累计触发)');
      }
      lines.push('');
    }

    const messageBuilder = new MessageBuilder();
    messageBuilder.text(lines.join('\n').trimEnd());
    return {
      success: true,
      segments: messageBuilder.build(),
    };
  }
}

// Command toggle command has been moved to ConversationConfigPlugin
// This file is kept for reference but the command is no longer registered here
