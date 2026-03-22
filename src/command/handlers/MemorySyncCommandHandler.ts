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
 * Reads all memory files for the current group and re-indexes them.
 */
@Command({
  name: 'memory_sync',
  description: '将本地记忆文件重新同步到 Qdrant 向量数据库',
  usage: '/memory_sync',
  permissions: ['owner'],
  aliases: ['同步记忆'],
})
@injectable()
export class MemorySyncCommand implements CommandHandler {
  name = 'memory_sync';
  description = '将本地记忆文件重新同步到 Qdrant 向量数据库';
  usage = '/memory_sync';

  constructor(
    @inject(DITokens.MEMORY_SERVICE) private memoryService: MemoryService,
    @inject(DITokens.MESSAGE_API) private messageAPI: MessageAPI,
    @inject(DITokens.CONFIG) private config: Config,
  ) {}

  execute(_args: string[], context: CommandContext): CommandResult {
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

    // Fire-and-forget: run sync and notify on completion
    this.memoryService
      .syncMemoryToRAG(groupId)
      .then((stats) => {
        const msg =
          `记忆同步完成：群记忆 ${stats.groupSynced ? '✓' : '无内容'}，` +
          `${stats.usersSynced.length} 个用户记忆已同步，` +
          `共 ${stats.totalFacts} 个记忆段落。`;
        return this.messageAPI.sendFromContext(msg, context, 10000);
      })
      .catch((err) => {
        logger.error('[MemorySyncCommand] sync failed:', err);
        this.messageAPI.sendFromContext('记忆同步失败，请查看日志。', context, 10000).catch(() => {});
      });

    return { success: true, segments: [{ type: 'text', data: { text: '正在同步记忆到 Qdrant，请稍候...' } }] };
  }
}
