// Builtin command handlers

import { spawn } from 'node:child_process';
import path from 'node:path';
import { inject, injectable } from 'tsyringe';
import type { AIManager } from '@/ai/AIManager';
import type { AIService } from '@/ai/AIService';
import type { CapabilityType } from '@/ai/capabilities/types';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { ProactiveConversationService } from '@/conversation/proactive';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { PluginManager } from '@/plugins/PluginManager';
import type { MemoryPlugin } from '@/plugins/plugins/MemoryPlugin';
import type { InfoCardData, ListCardData } from '@/services/card';
import { logger } from '@/utils/logger';
import type { CommandManager } from '../CommandManager';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult, PermissionLevel } from '../types';

/** Template name for trigger words: preference.{preferenceKey}.trigger (prompts/preference/{key}/trigger.txt). */
const TRIGGER_TEMPLATE_SUFFIX = '.trigger';

/**
 * Help command - shows available commands as a card image via AIService (same card pipeline as reply handleCardReply).
 * Falls back to text if card rendering fails (e.g. browser not available).
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

  constructor(
    @inject(DITokens.COMMAND_MANAGER) private commandManager: CommandManager,
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
  ) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
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
      const parts: string[] = [];
      if (handler.description) {
        parts.push(handler.description);
      }
      if (handler.usage) {
        parts.push(`Usage: ${handler.usage}`);
      }
      const cardData: InfoCardData = {
        type: 'info',
        title: `/${handler.name}`,
        content: parts.join('\n\n'),
        level: 'tip',
      };

      try {
        const segments = await this.aiService.renderCardToSegments(JSON.stringify(cardData));
        return {
          success: true,
          segments,
        };
      } catch (err) {
        logger.warn('[HelpCommand] Card render failed, falling back to text:', err);
        const help = [handler.description, handler.usage].filter(Boolean).join('\nUsage: ');
        const messageBuilder = new MessageBuilder();
        messageBuilder.text(`Command: /${handler.name}\n${help}`);
        return {
          success: true,
          segments: messageBuilder.build(),
        };
      }
    }

    // Show all commands as list card
    const items = commands.map((c) => {
      const h = c.handler;
      return h.description ? `/${h.name} — ${h.description}` : `/${h.name}`;
    });
    items.push('💡 Use /help <command> for details');

    const cardData: ListCardData = {
      type: 'list',
      title: 'Available Commands',
      items,
      emoji: '📋',
    };

    try {
      const segments = await this.aiService.renderCardToSegments(JSON.stringify(cardData));
      return {
        success: true,
        segments,
      };
    } catch (err) {
      logger.warn('[HelpCommand] Card render failed, falling back to text:', err);
      const commandList = commands
        .map((c) => {
          const h = c.handler;
          return h.description ? `/${h.name} - ${h.description}` : `/${h.name}`;
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

/** Delay before running restart script (ms), to allow reply to be sent first */
const RESTART_DELAY_MS = 2000;

/** Log file for restart script stdout/stderr when run via nohup */
const RESTART_LOG = '/tmp/qqbot-restart.log';

/**
 * Restart command: bot exits, then git pull + install + pm2 restart via start.sh.
 * Spawns the restart script in a new session (nohup) so it keeps running after
 * this process is killed by "pm2 delete" inside start.sh.
 * Requires admin or owner permission.
 */
@Command({
  name: 'restart',
  description: 'Update code (git pull), install deps, then restart the bot. Admin/owner only.',
  usage: '/restart',
  permissions: ['admin', 'owner'],
})
@injectable()
export class RestartCommand implements CommandHandler {
  name = 'restart';
  description = 'Update code (git pull), install deps, then restart the bot. Admin/owner only.';
  usage = '/restart';

  execute(_args: string[]): CommandResult {
    const messageBuilder = new MessageBuilder();
    messageBuilder.text(`正在拉取代码并重启...`);

    const scriptPath = path.join(process.cwd(), 'start.sh');
    const delaySec = RESTART_DELAY_MS / 1000;
    const env = {
      ...process.env,
      RESTART_SCRIPT: scriptPath,
      RESTART_DELAY_S: String(delaySec),
    };

    setTimeout(() => {
      // Run restart in nohup so it survives when this process is killed by pm2 delete.
      // Inner bash is reparented to init when our child (outer bash) is killed.
      const child = spawn(
        'bash',
        ['-c', 'nohup bash -c "sleep $RESTART_DELAY_S; \\"$RESTART_SCRIPT\\"" </dev/null >>"$RESTART_LOG" 2>&1 &'],
        {
          env: { ...env, RESTART_LOG },
          cwd: process.cwd(),
          detached: true,
          stdio: 'ignore',
        },
      );
      child.unref();
      logger.info(
        '[RestartCommand] spawned nohup restart script (delay %ds then start.sh); bot will exit when pm2 delete runs',
        delaySec,
      );
    }, RESTART_DELAY_MS);

    return {
      success: true,
      segments: messageBuilder.build(),
    };
  }
}

// Command toggle command has been moved to ConversationConfigPlugin
// This file is kept for reference but the command is no longer registered here
