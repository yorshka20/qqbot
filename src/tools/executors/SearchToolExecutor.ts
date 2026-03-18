// Search task executor - handles web search queries

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { RetrievalService } from '@/services/retrieval';
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

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const query = call.parameters?.query as string | undefined;

    if (!query) {
      return this.error('请提供搜索关键词', 'Missing required parameter: query');
    }

    if (!this.retrievalService?.isSearchEnabled()) {
      logger.info('[SearchToolExecutor] Search is not enabled, skipping search');
      return this.success('', { query, results: [] });
    }

    logger.info(`[SearchToolExecutor] Executing search for query: ${query}`);

    const searchResults = await this.retrievalService.search(query);

    if (searchResults.length === 0) {
      return this.success('', { query, results: [] });
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
