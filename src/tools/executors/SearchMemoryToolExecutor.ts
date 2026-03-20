// Search memory task executor - searches local group memory across users

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { GROUP_MEMORY_USER_ID, type MemoryService } from '@/memory/MemoryService';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

@Tool({
  name: 'search_memory',
  description:
    '按关键词搜索 bot 提取的结构化记忆（用户偏好、设定、历史事实等）。可跨用户检索。注意：这不是搜索聊天记录，而是搜索 bot 从聊天中提取并保存的长期记忆摘要。',
  executor: 'search_memory',
  visibility: ['reply', 'subagent'],
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: '搜索关键词或短语（如 "Unity"、"生日"、"Python"）',
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
      description: '最大返回条数，默认 5',
    },
  },
  examples: ['搜索群里关于某人的记忆', '看看谁的记忆里提到 Unity', '在本地记忆里查找这个设定'],
  triggerKeywords: ['搜索记忆', '记忆搜索', 'memory search', '查记忆'],
  whenToUse:
    '当需要查找 bot 记住的关于某人或某话题的信息时调用（如"谁喜欢Unity"、"群里有什么规矩"）。搜索的是 bot 提取的记忆摘要，不是原始聊天记录——要搜索原始聊天记录请用 rag_search。与 get_memory 的区别：get_memory 读取某人完整记忆，search_memory 按关键词跨用户搜索。',
})
@injectable()
export class SearchMemoryToolExecutor extends BaseToolExecutor {
  name = 'search_memory';

  constructor(@inject(DITokens.MEMORY_SERVICE) private memoryService: MemoryService) {
    super();
  }

  execute(call: ToolCall, context: ToolExecutionContext): ToolResult {
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
        : 5;

    const results = this.memoryService.searchMemories(groupId, query, {
      userId,
      includeGroupMemory,
      limit,
    });

    if (results.length === 0) {
      return this.success('未找到相关记忆', {
        groupId,
        query,
        results: [],
      });
    }

    const formatted = results
      .map((result, index) => {
        const label = result.isGroupMemory ? '群记忆' : `用户 ${result.userId}`;
        return `${index + 1}. ${label}\n${result.snippet}`;
      })
      .join('\n\n');

    return this.success(formatted, {
      groupId,
      query,
      results: results.map((result) => ({
        ...result,
        userId: result.userId === GROUP_MEMORY_USER_ID ? 'group' : result.userId,
      })),
    });
  }
}
