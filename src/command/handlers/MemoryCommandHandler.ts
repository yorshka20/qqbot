// Memory command handlers: deep extract and memory edit

import { inject, injectable } from 'tsyringe';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { MemoryExtractService } from '@/memory';
import type { MemoryService } from '@/memory/MemoryService';
import { MessageBuilder } from '@/message/MessageBuilder';
import { MessageUtils } from '@/message/MessageUtils';
import type { PluginManager } from '@/plugins/PluginManager';
import type { MemoryPlugin } from '@/plugins/plugins/MemoryPlugin';
import { logger } from '@/utils/logger';
import { CommandArgsParser, type ParserConfig } from '../CommandArgsParser';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

/**
 * Deep memory command - trigger memory extract for user or group with time range.
 * Usage: /memory_deep [--target=user|group] [--days=7]
 */
@Command({
  name: 'memory_deep',
  description: '深度记忆整理：分析群历史消息并更新记忆',
  usage: '/memory_deep [--target=user|group] [--days=天数] — 默认 user 最近7天',
  permissions: ['user'],
  aliases: ['深度记忆'],
})
@injectable()
export class MemoryDeepCommand implements CommandHandler {
  name = 'memory_deep';
  description = '深度记忆整理：分析群历史消息并更新记忆';
  usage = '/memory_deep [--target=user|group] [--days=天数] — 默认 user 最近7天';

  private readonly argsConfig: ParserConfig = {
    options: {
      target: { property: 'target', type: 'string', aliases: ['t'] },
      days: { property: 'days', type: 'number', aliases: ['d'] },
    },
  };

  constructor(
    @inject(DITokens.PLUGIN_MANAGER) private pluginManager: PluginManager,
    @inject(DITokens.MESSAGE_API) private messageAPI: MessageAPI,
  ) {}

  execute(args: string[], context: CommandContext): CommandResult {
    if (context.messageType !== 'group' || context.groupId === undefined) {
      return { success: false, error: '仅支持在群聊中使用。' };
    }

    const memoryPlugin = this.pluginManager.getPluginAs<MemoryPlugin>('memory');
    if (!memoryPlugin) {
      return { success: false, error: '记忆插件未加载。' };
    }
    if (!this.pluginManager.getEnabledPlugins().includes('memory')) {
      return { success: false, error: '记忆插件未启用。' };
    }

    const { options } = CommandArgsParser.parse<{ target?: string; days?: number }>(args, this.argsConfig);
    const target: 'user' | 'group' =
      options.target === 'group' || options.target === '群组' ? 'group' : 'user';
    const days = Math.min(Math.max(Math.floor(options.days ?? 7), 1), 365);

    const groupId = context.groupId.toString();
    const userId = context.userId.toString();

    // Group memory extract requires admin/owner
    if (target === 'group') {
      const config = getContainer().resolve<Config>(DITokens.CONFIG);
      const botConfig = config.getConfig().bot;
      if (!MessageUtils.isAdmin(userId, botConfig)) {
        return { success: false, error: '群组记忆整理仅限管理员或owner使用。' };
      }
    }

    const since = new Date();
    since.setDate(since.getDate() - days);
    const targetLabel = target === 'group' ? '群组' : `用户 ${userId}`;

    // Fire-and-forget: run extract and notify on completion
    if (target === 'user') {
      memoryPlugin.runExtractForUserSince(groupId, userId, since, (success) => {
        const msg = success
          ? `${targetLabel} 的记忆整理完成（最近${days}天）。`
          : `${targetLabel} 的记忆整理过程中出现了问题，请查看日志。`;
        this.messageAPI.sendFromContext(msg, context, 10000).catch((err) => {
          logger.warn('[MemoryDeepCommand] send completion notification failed:', err);
        });
      });
    } else {
      memoryPlugin.runExtractForGroupSince(groupId, since, (success) => {
        const msg = success
          ? `${targetLabel}记忆整理完成（最近${days}天）。`
          : `${targetLabel}记忆整理过程中出现了问题，请查看日志。`;
        this.messageAPI.sendFromContext(msg, context, 10000).catch((err) => {
          logger.warn('[MemoryDeepCommand] send completion notification failed:', err);
        });
      });
    }

    return {
      success: true,
      segments: new MessageBuilder()
        .text(`收到，正在整理${targetLabel}的记忆（最近${days}天）...`)
        .build(),
    };
  }
}

/**
 * Memory edit command - directly insert/merge content into user or group memory.
 * Usage: /memory_edit [--target=user|group] [--user=userId] <content>
 */
@Command({
  name: 'memory_edit',
  description: '记忆订正：直接将内容写入记忆',
  usage: '/memory_edit [--target=user|group] [--user=用户ID] <内容>',
  permissions: ['user'],
  aliases: ['记忆订正'],
})
@injectable()
export class MemoryEditCommand implements CommandHandler {
  name = 'memory_edit';
  description = '记忆订正：直接将内容写入记忆';
  usage = '/memory_edit [--target=user|group] [--user=用户ID] <内容>';

  private readonly argsConfig: ParserConfig = {
    options: {
      target: { property: 'target', type: 'string', aliases: ['t'] },
      user: { property: 'user', type: 'string', aliases: ['u'] },
    },
  };

  constructor(
    @inject(DITokens.MESSAGE_API) private messageAPI: MessageAPI,
    @inject(DITokens.MEMORY_SERVICE) private memoryService: MemoryService,
    @inject(DITokens.MEMORY_EXTRACT_SERVICE) private memoryExtractService: MemoryExtractService,
  ) {}

  execute(args: string[], context: CommandContext): CommandResult {
    if (context.messageType !== 'group' || context.groupId === undefined) {
      return { success: false, error: '仅支持在群聊中使用。' };
    }
    if (args.length === 0) {
      return {
        success: false,
        error: '请提供要写入的内容。用法: /memory_edit [--target=user|group] [--user=用户ID] <内容>',
      };
    }

    const groupId = context.groupId.toString();
    const callerUserId = context.userId.toString();
    const config = getContainer().resolve<Config>(DITokens.CONFIG);
    const botConfig = config.getConfig().bot;
    const isAdminOrOwner = MessageUtils.isAdmin(callerUserId, botConfig);

    const { text: content, options } = CommandArgsParser.parse<{ target?: string; user?: string }>(
      args,
      this.argsConfig,
    );
    const target: 'user' | 'group' =
      options.target === 'group' || options.target === '群组' ? 'group' : 'user';
    let targetUserId = options.user ?? callerUserId;

    if (!content.trim()) {
      return { success: false, error: '请提供要写入的内容。' };
    }

    // Permission checks
    if (target === 'group' && !isAdminOrOwner) {
      return { success: false, error: '群组记忆订正仅限管理员或owner使用。' };
    }
    if (target === 'user' && targetUserId !== callerUserId && !isAdminOrOwner) {
      // Regular user: ignore specified userId, always edit own memory
      targetUserId = callerUserId;
    }

    // Fire-and-forget: merge and notify
    if (target === 'group') {
      const existing = this.memoryService.getGroupMemoryText(groupId);
      this.memoryExtractService
        .mergeWithExisting(existing, content, 'global')
        .then(async (merged: string) => {
          if (merged) {
            await this.memoryService.upsertMemory(groupId, '_global_', true, merged);
          }
          await this.messageAPI.sendFromContext('群组记忆订正完成。', context, 10000);
        })
        .catch((err: unknown) => {
          logger.warn('[MemoryEditCommand] group memory edit failed:', err);
          this.messageAPI.sendFromContext('群组记忆订正失败，请查看日志。', context, 10000).catch(() => {});
        });
    } else {
      const existing = this.memoryService.getUserMemoryText(groupId, targetUserId);
      this.memoryExtractService
        .mergeWithExisting(existing, content, 'user')
        .then(async (merged: string) => {
          if (merged) {
            await this.memoryService.upsertMemory(groupId, targetUserId, false, merged);
          }
          const label = targetUserId === callerUserId ? '你的' : `用户 ${targetUserId} 的`;
          await this.messageAPI.sendFromContext(`${label}记忆订正完成。`, context, 10000);
        })
        .catch((err: unknown) => {
          logger.warn('[MemoryEditCommand] user memory edit failed:', err);
          this.messageAPI.sendFromContext('记忆订正失败，请查看日志。', context, 10000).catch(() => {});
        });
    }

    const targetLabel =
      target === 'group'
        ? '群组'
        : targetUserId === callerUserId
          ? '你的'
          : `用户 ${targetUserId} 的`;
    return {
      success: true,
      segments: new MessageBuilder().text(`收到，正在订正${targetLabel}记忆...`).build(),
    };
  }
}
