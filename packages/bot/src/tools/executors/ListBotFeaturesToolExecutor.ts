// ListBotFeatures tool executor — lists bot commands, plugins, and features for AI to explain to users

import { inject, injectable } from 'tsyringe';
import type { CommandManager } from '@/command/CommandManager';
import type { PermissionLevel } from '@/command/types';
import { DITokens } from '@/core/DITokens';
import type { PluginManager } from '@/plugins/PluginManager';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

@Tool({
  name: 'list_bot_features',
  description:
    '列出机器人的所有可用命令和功能。返回命令名称、用法、描述和权限要求，以及已启用的插件列表。用户询问"怎么用"、"有什么功能"时调用。',
  executor: 'list_bot_features',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'] }, subagent: true },
  parameters: {
    query: {
      type: 'string',
      required: false,
      description: '按关键词过滤命令/功能名称或描述（如 "图片"、"记忆"、"搜索"）。省略则返回完整列表。',
    },
  },
  examples: ['bot有什么功能', '怎么用文生图', '有哪些命令可以用', '帮助'],
  triggerKeywords: ['功能', '命令', '帮助', 'help', '怎么用', '用法'],
  whenToUse: '当用户询问 bot 有哪些功能、怎么使用某个命令、或需要帮助时调用。也适用于用户不知道某个功能存在的场景。',
})
@injectable()
export class ListBotFeaturesToolExecutor extends BaseToolExecutor {
  name = 'list_bot_features';

  constructor(
    @inject(DITokens.COMMAND_MANAGER) private commandManager: CommandManager,
    @inject(DITokens.PLUGIN_MANAGER) private pluginManager: PluginManager,
  ) {
    super();
  }

  execute(call: ToolCall, context: ToolExecutionContext): ToolResult {
    const query = (call.parameters?.query as string | undefined)?.trim().toLowerCase();

    // Get all commands (use a permissive context so all commands are listed)
    const allCommands = this.commandManager.getAllCommands({
      userId: context.userId?.toString() ?? '0',
      groupId: context.groupId?.toString() ?? '',
      userType: 'owner' as PermissionLevel,
    });

    // Get enabled plugins
    const enabledPlugins = this.pluginManager.getEnabledPlugins();
    const allPlugins = this.pluginManager.getAllPlugins();

    // Filter commands by query if provided
    const filteredCommands = query
      ? allCommands.filter((reg) => {
          const handler = reg.handler;
          const nameMatch = handler.name?.toLowerCase().includes(query);
          const descMatch = handler.description?.toLowerCase().includes(query);
          const usageMatch = handler.usage?.toLowerCase().includes(query);
          return nameMatch || descMatch || usageMatch;
        })
      : allCommands;

    // Format commands
    const commandLines = filteredCommands.map((reg) => {
      const handler = reg.handler;
      const perms = reg.permissions?.length ? ` [${reg.permissions.join('/')}]` : '';
      const usage = handler.usage ? ` — 用法: ${handler.usage}` : '';
      const desc = handler.description ? ` — ${handler.description}` : '';
      const aliases = reg.aliases?.length ? ` (别名: ${reg.aliases.join(', ')})` : '';
      return `/${handler.name}${aliases}${perms}${desc}${usage}`;
    });

    // Format plugins
    const pluginLines = allPlugins.map((plugin) => {
      const enabled = enabledPlugins.includes(plugin.name) ? '✅' : '❌';
      return `${enabled} ${plugin.name}: ${plugin.description || '(无描述)'}`;
    });

    const sections: string[] = [];

    if (commandLines.length > 0) {
      sections.push(`## 命令列表${query ? `（关键词: "${query}"）` : ''}\n${commandLines.join('\n')}`);
    } else if (query) {
      sections.push(`未找到与 "${query}" 相关的命令。`);
    }

    if (!query && pluginLines.length > 0) {
      sections.push(`## 插件列表\n${pluginLines.join('\n')}`);
    }

    const reply = sections.join('\n\n');

    return this.success(reply, {
      commandCount: filteredCommands.length,
      totalCommands: allCommands.length,
      enabledPlugins: enabledPlugins.length,
      totalPlugins: allPlugins.length,
    });
  }
}
