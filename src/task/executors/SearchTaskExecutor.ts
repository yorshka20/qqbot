// Search task executor - handles web search queries

import { DITokens } from '@/core/DITokens';
import type { SearchService } from '@/search';
import { logger } from '@/utils/logger';
import { inject, injectable } from 'tsyringe';
import { TaskDefinition } from '../decorators';
import type { Task, TaskExecutionContext, TaskResult } from '../types';
import { BaseTaskExecutor } from './BaseTaskExecutor';

/**
 * Search task executor
 * Handles web search queries
 */
@TaskDefinition({
  name: 'search',
  description: 'Perform web search for information',
  executor: 'search',
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: 'Search query string',
    },
  },
  examples: [
    '搜索一下Python教程',
    '帮我查一下最新的AI新闻',
    '什么是量子计算？',
  ],
  triggerKeywords: ['搜索', 'search', '查', '找', '查询', '了解'],
  whenToUse: 'Use this task when user asks to search for information, look up something, or find content on the web.',
})
@injectable()
export class SearchTaskExecutor extends BaseTaskExecutor {
  name = 'search';

  constructor(@inject(DITokens.SEARCH_SERVICE) private searchService?: SearchService) {
    super();
  }

  async execute(task: Task, context: TaskExecutionContext): Promise<TaskResult> {
    const query = task.parameters?.query as string | undefined;

    if (!query) {
      return this.error('请提供搜索关键词', 'Missing required parameter: query');
    }

    if (!this.searchService?.isEnabled()) {
      logger.warn('[SearchTaskExecutor] SearchService is not enabled');
      return this.error('搜索功能暂时不可用：搜索服务未启用', 'SearchService not enabled');
    }

    try {
      logger.info(`[SearchTaskExecutor] Executing search for query: ${query}`);

      // Perform search using SearchService
      const searchResults = await this.searchService.search(query);

      if (searchResults.length === 0) {
        return this.success(
          `未找到与"${query}"相关的搜索结果。`,
          { query, results: [] },
        );
      }

      // Format search results for display
      const formattedResults = this.searchService.formatSearchResults(searchResults);

      logger.info(`[SearchTaskExecutor] Search completed: ${searchResults.length} results found`);

      return this.success(
        formattedResults,
        {
          query,
          results: searchResults,
          resultCount: searchResults.length,
        },
      );
    } catch (error) {
      logger.error('[SearchTaskExecutor] Search failed:', error);
      return this.error(
        `搜索失败：${error instanceof Error ? error.message : '未知错误'}`,
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  }
}
