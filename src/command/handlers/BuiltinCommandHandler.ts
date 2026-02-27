// Builtin command handlers

import { exec } from 'node:child_process';
import { inject, injectable } from 'tsyringe';
import type { AIManager } from '@/ai/AIManager';
import type { CapabilityType } from '@/ai/capabilities/types';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { ProactiveConversationService } from '@/conversation/proactive';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { PluginManager } from '@/plugins/PluginManager';
import type { MemoryPlugin } from '@/plugins/plugins/MemoryPlugin';
import { logger } from '@/utils/logger';
import type { CommandManager } from '../CommandManager';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult, PermissionLevel } from '../types';

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

  constructor(@inject(DITokens.COMMAND_MANAGER) private commandManager: CommandManager) {}

  execute(args: string[], context: CommandContext): CommandResult {
    const commands = this.commandManager.getAllCommands({
      userId: context.userId.toString(),
      groupId: context.groupId?.toString() ?? '',
      userType: context.metadata.senderRole as PermissionLevel,
    });

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
  ) {}

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

/**
 * Deep memory command - trigger full-history memory extract for the current user in this group.
 * Similar to MemoryTrigger but runs analysis over all history messages for this user in the group.
 */
@Command({
  name: 'memory_deep',
  description: 'Trigger deep memory consolidation: analyze group history and update your memory',
  usage: '/memory_deep or /深度记忆',
  permissions: ['user'],
  aliases: ['深度记忆'],
})
@injectable()
export class MemoryDeepCommand implements CommandHandler {
  name = 'memory_deep';
  description = 'Trigger deep memory consolidation: analyze group history and update your memory';
  usage = '/memory_deep or /深度记忆';

  constructor(@inject(DITokens.PLUGIN_MANAGER) private pluginManager: PluginManager) {}

  execute(_args: string[], context: CommandContext): CommandResult {
    if (context.messageType !== 'group' || context.groupId === undefined) {
      return {
        success: false,
        error: '仅支持在群聊中使用，用于整理你在本群的历史记忆。',
      };
    }

    const memoryPlugin = this.pluginManager.getPluginAs<MemoryPlugin>('memory');
    if (!memoryPlugin) {
      return {
        success: false,
        error: '记忆插件未加载，无法执行深度记忆整理。',
      };
    }
    if (!this.pluginManager.getEnabledPlugins().includes('memory')) {
      return {
        success: false,
        error: '记忆插件未启用，请先在当前群启用 memory 插件。',
      };
    }

    const groupId = context.groupId.toString();
    const userId = context.userId.toString();
    memoryPlugin.runFullHistoryExtractForUser(groupId, userId);

    const messageBuilder = new MessageBuilder();
    messageBuilder.text('已加入深度记忆整理队列，将根据本群历史分析并更新你的记忆，完成后无需额外操作。');
    return {
      success: true,
      segments: messageBuilder.build(),
    };
  }
}

/** Delay before executing pm2 restart (ms), to allow reply to be sent first */
const RESTART_DELAY_MS = 2000;

/**
 * Restart command - restarts the bot via pm2 restart
 * Requires admin or owner permission
 */
@Command({
  name: 'restart',
  description: 'Restart the bot. Admin/owner only.',
  usage: '/restart [pm2_id]',
  permissions: ['admin', 'owner'],
})
@injectable()
export class RestartCommand implements CommandHandler {
  name = 'restart';
  description = 'Restart the bot. Admin/owner only.';
  usage = '/restart [pm2_id]';

  execute(args: string[]): CommandResult {
    const pm2Id = args[0] ?? '0';
    // Sanitize: only allow alphanumeric, dash, underscore (prevent command injection)
    if (!/^[a-zA-Z0-9_-]+$/.test(pm2Id)) {
      return {
        success: false,
        error: '无效的 pm2 id，仅支持字母、数字、横线、下划线',
      };
    }

    const messageBuilder = new MessageBuilder();
    messageBuilder.text(`正在重启...`);

    setTimeout(() => {
      exec(`pm2 restart ${pm2Id}`, (err, stdout, stderr) => {
        if (err) {
          logger.error('[RestartCommand] pm2 restart failed:', { err, stdout, stderr });
        }
      });
    }, RESTART_DELAY_MS);

    return {
      success: true,
      segments: messageBuilder.build(),
    };
  }
}

// Command toggle command has been moved to ConversationConfigPlugin
// This file is kept for reference but the command is no longer registered here
