// Fetch page task executor - fetches main article/page content from a URL for agent use

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { RetrievalService } from '@/services/retrieval';
import { logger } from '@/utils/logger';
import { TaskDefinition } from '../decorators';
import type { Task, TaskExecutionContext, TaskResult } from '../types';
import { BaseTaskExecutor } from './BaseTaskExecutor';

/**
 * Fetch page task executor
 * Fetches main article or page content from a URL (Readability or video description). Agent can call independently.
 */
@TaskDefinition({
  name: 'fetch_page',
  description: 'Fetch main article or page content from a URL (extract text via Readability or video description)',
  executor: 'fetch_page',
  parameters: {
    url: {
      type: 'string',
      required: true,
      description: 'URL to fetch (e.g. https://example.com/article)',
    },
    title: {
      type: 'string',
      required: false,
      description: 'Optional title for the page; when omitted, URL is used',
    },
  },
  examples: ['抓取这个网页内容', 'fetch 这个链接的正文', '获取该 URL 的页面内容'],
  triggerKeywords: ['抓取', 'fetch', '网页内容', '链接内容', 'URL 内容', '页面正文'],
  whenToUse:
    'Use when user or context provides a URL and you need the main text content of that page (article body or video description).',
})
@injectable()
export class FetchPageTaskExecutor extends BaseTaskExecutor {
  name = 'fetch_page';

  constructor(@inject(DITokens.RETRIEVAL_SERVICE) private retrievalService: RetrievalService) {
    super();
  }

  async execute(task: Task, _context: TaskExecutionContext): Promise<TaskResult> {
    const url = task.parameters?.url as string | undefined;
    const title = (task.parameters?.title as string | undefined) ?? url ?? '无标题';

    if (!url) {
      return this.error('请提供 URL', 'Missing required parameter: url');
    }

    const fetchService = this.retrievalService.getPageContentFetchService();
    if (!fetchService.isEnabled()) {
      logger.info('[FetchPageTaskExecutor] Page fetch is not enabled (config)');
      return this.error('页面抓取功能未开启', 'fetch_page is disabled by config');
    }

    logger.info(`[FetchPageTaskExecutor] Fetching page: ${url}`);

    const entries = await fetchService.fetchPages([{ url, title }]);
    if (entries.length === 0) {
      return this.success('', {
        url,
        title,
        text: '',
      });
    }

    const entry = entries[0];
    return this.success(entry.text, {
      url: entry.url,
      title: entry.title,
      text: entry.text,
    });
  }
}
