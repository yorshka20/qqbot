// Search memory task executor - semantic search over bot-extracted memory facts
// Uses RAG (vector search) when available, falls back to keyword matching

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { GROUP_MEMORY_USER_ID, type MemoryService } from '@/memory/MemoryService';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

const DEFAULT_LIMIT = 8;
const DEFAULT_MIN_SCORE = 0.6;

@Tool({
  name: 'search_memory',
  description:
    '语义搜索 bot 提取的结构化记忆（用户偏好、设定、历史事实等）。使用向量相似度匹配，可跨用户检索。注意：这不是搜索聊天记录，而是搜索 bot 从聊天中提取并保存的长期记忆摘要。',
  executor: 'search_memory',
  visibility: ['subagent'],
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

  constructor(@inject(DITokens.MEMORY_SERVICE) private memoryService: MemoryService) {
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

    // Prefer RAG semantic search when available
    if (this.memoryService.isRAGEnabled()) {
      return this.executeWithRAG(groupId, query, userId, includeGroupMemory, limit);
    }

    // Fallback to keyword search
    logger.debug('[SearchMemoryToolExecutor] RAG not available, falling back to keyword search');
    return this.executeWithKeyword(groupId, query, userId, includeGroupMemory, limit);
  }

  private async executeWithRAG(
    groupId: string,
    query: string,
    userId: string | undefined,
    _includeGroupMemory: boolean,
    limit: number,
  ): Promise<ToolResult> {
    const result = await this.memoryService.getFilteredMemoryForReplyAsync(groupId, userId, {
      userMessage: query,
      alwaysIncludeScopes: [], // Don't force-include anything — pure relevance search
      minRelevanceScore: DEFAULT_MIN_SCORE,
      count: limit,
    });

    const parts: string[] = [];
    if (result.groupMemoryText) {
      parts.push(`群记忆:\n${result.groupMemoryText}`);
    }
    if (result.userMemoryText) {
      parts.push(`用户记忆:\n${result.userMemoryText}`);
    }

    if (parts.length === 0) {
      return this.success('未找到相关记忆', { groupId, query, method: 'rag', results: [] });
    }

    const formatted = parts.join('\n\n');
    const totalFound = result.stats.groupIncluded + result.stats.userIncluded;

    return this.success(formatted, {
      groupId,
      query,
      method: 'rag',
      totalFound,
      stats: result.stats,
    });
  }

  private executeWithKeyword(
    groupId: string,
    query: string,
    userId: string | undefined,
    includeGroupMemory: boolean,
    limit: number,
  ): ToolResult {
    const results = this.memoryService.searchMemories(groupId, query, {
      userId,
      includeGroupMemory,
      limit,
    });

    if (results.length === 0) {
      return this.success('未找到相关记忆', { groupId, query, method: 'keyword', results: [] });
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
      method: 'keyword',
      results: results.map((result) => ({
        ...result,
        userId: result.userId === GROUP_MEMORY_USER_ID ? 'group' : result.userId,
      })),
    });
  }
}
