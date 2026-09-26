// Search memory task executor - search stored memory facts across the group
// (vector search over automatic facts, substring match over manual ones)

import { inject, injectable } from 'tsyringe';
import { MemoryService } from '@/memory/MemoryService';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

const DEFAULT_LIMIT = 8;

@Tool({
  name: 'search_memory',
  description:
    '语义搜索 bot 提取的结构化记忆（用户偏好、设定、历史事实等）。使用向量相似度匹配，可跨用户检索。注意：这不是搜索聊天记录，而是搜索 bot 从聊天中提取并保存的长期记忆摘要。',
  executor: 'search_memory',
  visibility: { subagent: true },
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: '语义搜索查询文本（自然语言描述要找的内容，如"谁喜欢Python"、"群里的规矩"）',
    },
    userId: {
      type: 'string',
      required: false,
      description: '限定搜索范围为该用户 QQ 号。省略则搜索群内所有用户的记忆。',
    },
    includeGroupMemory: {
      type: 'boolean',
      required: false,
      description: '是否包含群整体记忆。默认 true。',
    },
    limit: {
      type: 'number',
      required: false,
      description: `最大返回条数，默认 ${DEFAULT_LIMIT}`,
    },
  },
  examples: ['搜索群里关于某人的记忆', '看看谁的记忆里提到 Unity', '在本地记忆里查找这个设定'],
  triggerKeywords: ['搜索记忆', '记忆搜索', 'memory search', '查记忆'],
  whenToUse:
    '当需要查找 bot 记住的关于某人或某话题的信息时调用（如"谁喜欢Unity"、"群里有什么规矩"）。搜索的是 bot 提取的记忆摘要，不是原始聊天记录——要搜索原始聊天记录请用 rag_search。与 get_memory 的区别：get_memory 读取某人完整记忆，search_memory 按语义跨用户搜索。',
})
@injectable()
export class SearchMemoryToolExecutor extends BaseToolExecutor {
  name = 'search_memory';

  constructor(@inject(MemoryService) private memoryService: MemoryService) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const groupId = context.groupId?.toString();
    if (!groupId) {
      return this.error('只有群聊场景下才能搜索本地记忆', 'search_memory requires group context');
    }

    const query = typeof call.parameters?.query === 'string' ? call.parameters.query.trim() : '';
    if (!query) {
      return this.error('请提供要搜索的记忆关键词', 'Missing required parameter: query');
    }

    const userId = typeof call.parameters?.userId === 'string' ? call.parameters.userId.trim() : undefined;
    const includeGroupMemory = call.parameters?.includeGroupMemory !== false;
    const limit =
      typeof call.parameters?.limit === 'number' && Number.isFinite(call.parameters.limit)
        ? Math.max(1, Math.floor(call.parameters.limit))
        : DEFAULT_LIMIT;

    const result = await this.memoryService.searchMemory(groupId, query, { userId, includeGroupMemory, limit });
    const method = this.memoryService.isSearchEnabled() ? 'vector' : 'keyword';
    if (result.count === 0) {
      return this.success('未找到相关记忆', { groupId, query, method, totalFound: 0 });
    }
    return this.success(result.text, { groupId, query, method, totalFound: result.count });
  }
}
