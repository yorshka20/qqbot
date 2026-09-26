import { inject, injectable } from 'tsyringe';
import { MessageAPI } from '@/api/methods/MessageAPI';
import { DITokens } from '@/core/DITokens';
import { MemoryFactStore } from '@/memory/storage/MemoryFactStore';
import type { PermissionChecker } from '@/permission';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

/**
 * Bring this group's memory vector index back to its stored facts: index the active facts
 * that are missing or changed, drop every other point.
 * Usage: /memory_sync
 */
@Command({
  name: 'memory_sync',
  description: '按数据库里的记忆重建本群的向量索引',
  usage: '/memory_sync',
  permissions: ['owner'],
  aliases: ['同步记忆'],
})
@injectable()
export class MemorySyncCommand implements CommandHandler {
  name = 'memory_sync';
  description = '按数据库里的记忆重建本群的向量索引';
  usage = '/memory_sync';

  constructor(
    @inject(MemoryFactStore) private factStore: MemoryFactStore,
    @inject(MessageAPI) private messageAPI: MessageAPI,
    @inject(DITokens.PERMISSION_CHECKER) private permissionChecker: PermissionChecker,
  ) {}

  execute(_args: string[], context: CommandContext): CommandResult {
    if (context.messageType !== 'group' || context.groupId === undefined) {
      return { success: false, error: '仅支持在群聊中使用。' };
    }
    if (!this.permissionChecker.isAdmin(context.userId.toString(), context.metadata.protocol)) {
      return { success: false, error: '仅限管理员使用。' };
    }
    if (!this.factStore.isIndexed()) {
      return { success: false, error: 'RAG 服务未启用，没有向量索引。' };
    }

    const groupId = context.groupId.toString();
    this.factStore
      .reindexGroup(groupId)
      .then(({ upserted, removed }) =>
        this.messageAPI.sendFromContext(`记忆索引已同步：写入 ${upserted} 条，移除 ${removed} 条。`, context, 10000),
      )
      .catch((err) => {
        logger.error('[MemorySyncCommand] sync failed:', err);
        this.messageAPI.sendFromContext('记忆索引同步失败，请查看日志。', context, 10000).catch(() => {});
      });

    return { success: true, segments: [{ type: 'text', data: { text: '正在同步本群的记忆索引…' } }] };
  }
}
