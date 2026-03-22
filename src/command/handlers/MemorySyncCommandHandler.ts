import { inject, injectable } from 'tsyringe';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import type { MemoryService } from '@/memory/MemoryService';
import { MessageUtils } from '@/message/MessageUtils';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

/**
 * Sync local markdown memory files to Qdrant RAG.
 * Usage:
 *   /memory_sync           — sync all (group + all users)
 *   /memory_sync group     — sync group memory only
 *   /memory_sync <userId>  — sync a specific user only
 */
@Command({
  name: 'memory_sync',
  description: '将本地记忆文件重新同步到 Qdrant 向量数据库',
  usage: '/memory_sync [group|<userId>]',
  permissions: ['owner'],
  aliases: ['同步记忆'],
})
@injectable()
export class MemorySyncCommand implements CommandHandler {
  name = 'memory_sync';
  description = '将本地记忆文件重新同步到 Qdrant 向量数据库';
  usage = '/memory_sync [group|<userId>]';

  constructor(
    @inject(DITokens.MEMORY_SERVICE) private memoryService: MemoryService,
    @inject(DITokens.MESSAGE_API) private messageAPI: MessageAPI,
    @inject(DITokens.CONFIG) private config: Config,
  ) {}

  execute(args: string[], context: CommandContext): CommandResult {
    if (context.messageType !== 'group' || context.groupId === undefined) {
      return { success: false, error: '仅支持在群聊中使用。' };
    }

    const userId = context.userId.toString();
    const botConfig = this.config.getConfig().bot;
    if (!MessageUtils.isAdmin(userId, botConfig)) {
      return { success: false, error: '仅限管理员使用。' };
    }

    if (!this.memoryService.isRAGEnabled()) {
      return { success: false, error: 'RAG 服务未启用，无法同步。' };
    }

    const groupId = context.groupId.toString();
    const arg = args[0]?.trim();

    let syncTarget: 'all' | 'group' | 'user' = 'all';
    let targetUserId: string | undefined;
    let label: string;

    if (arg === 'group' || arg === '群组') {
      syncTarget = 'group';
      label = '群记忆';
    } else if (arg) {
      syncTarget = 'user';
      targetUserId = arg;
      label = `用户 ${arg} 的记忆`;
    } else {
      label = '全部记忆';
    }

    this.memoryService
      .syncMemoryToRAG(groupId, syncTarget, targetUserId)
      .then((stats) => {
        const parts: string[] = ['记忆同步完成：'];
        if (syncTarget !== 'user') {
          parts.push(`群记忆 ${stats.groupSynced ? '✓' : '无内容'}`);
        }
        if (syncTarget !== 'group') {
          parts.push(`${stats.usersSynced.length} 个用户记忆已同步`);
        }
        parts.push(`共 ${stats.totalFacts} 个记忆段落`);
        return this.messageAPI.sendFromContext(parts.join('，'), context, 10000);
      })
      .catch((err) => {
        logger.error('[MemorySyncCommand] sync failed:', err);
        this.messageAPI.sendFromContext('记忆同步失败，请查看日志。', context, 10000).catch(() => {});
      });

    return { success: true, segments: [{ type: 'text', data: { text: `正在同步${label}到 Qdrant，请稍候...` } }] };
  }
}
