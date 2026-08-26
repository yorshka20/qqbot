// Search task executor - handles web search queries

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { RetrievalService } from '@/services/retrieval';
import type { SearchResult } from '@/services/retrieval/searxng/types';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

/**
 * Search task executor
 * Handles web search queries
 */
@Tool({
  name: 'search',
  description:
    '联网搜索实时信息。返回多条搜索结果摘要（标题、URL、正文片段）。适用于需要最新数据、事实核查或你不确定的知识。',
  executor: 'search',
  visibility: ['subagent'],
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: '搜索关键词或短语，尽量精炼（如 "2024 Nobel Physics winner"）',
    },
  },
  examples: ['搜索一下Python教程', '帮我查一下最新的AI新闻', '什么是量子计算？'],
  triggerKeywords: ['搜索', 'search', '查', '找', '查询', '了解'],
  whenToUse:
    '当用户请求查询实时信息、新闻、不确定的事实、或你训练数据之外的知识时调用。不要用于已知常识或群内记忆查询。',
})
@injectable()
export class SearchToolExecutor extends BaseToolExecutor {
  name = 'search';

  constructor(@inject(DITokens.RETRIEVAL_SERVICE) private retrievalService: RetrievalService) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const query = call.parameters?.query as string | undefined;

    if (!query) {
      return this.error('请提供搜索关键词', 'Missing required parameter: query');
    }

    if (!this.retrievalService.isSearchEnabled()) {
      return this.error('联网搜索未启用', 'search is not enabled');
    }

    logger.info(`[SearchToolExecutor] Executing search for query: ${query}`);

    let searchResults: SearchResult[];
    try {
      searchResults = await this.retrievalService.search(query);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[SearchToolExecutor] Search failed for query "${query}": ${message}`);
      // Distinct from an empty result on purpose: the model must not turn a
      // broken backend into "there is nothing about this".
      return this.error(
        `联网搜索后端故障，本次查询没有执行：${message}。这不等于「没有搜到内容」，不要据此下结论。`,
        message,
      );
    }

    if (searchResults.length === 0) {
      return this.success('搜索已执行，但没有匹配的结果。', { query, results: [] });
    }

    const formattedResults = this.retrievalService.formatSearchResults(searchResults);
    logger.info(`[SearchToolExecutor] Search completed: ${searchResults.length} results found`);

    return this.success(formattedResults, {
      query,
      results: searchResults,
      resultCount: searchResults.length,
    });
  }
}
