// Fetch page task executor - fetches main article/page content from a URL for agent use

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { RetrievalService } from '@/services/retrieval';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

/**
 * Fetch page task executor
 * Fetches main article or page content from a URL (Readability or video description). Agent can call independently.
 */
@Tool({
  name: 'fetch_page',
  description:
    '抓取指定 URL 的正文内容。自动提取文章主体文本或视频描述，去除导航和广告。适用于用户分享链接后需要阅读/总结内容的场景。',
  executor: 'fetch_page',
  parameters: {
    url: {
      type: 'string',
      required: true,
      description: '目标网页 URL（如 https://example.com/article）',
    },
    title: {
      type: 'string',
      required: false,
      description: '页面标题提示，省略时使用 URL',
    },
  },
  examples: ['抓取这个网页内容', 'fetch 这个链接的正文', '获取该 URL 的页面内容'],
  triggerKeywords: ['抓取', 'fetch', '网页内容', '链接内容', 'URL 内容', '页面正文'],
  whenToUse:
    '当对话中出现 URL 且需要了解其内容时调用。常见场景：用户分享链接求总结、需要引用链接内文。不要用于搜索——搜索请用 search。',
})
@injectable()
export class FetchPageToolExecutor extends BaseToolExecutor {
  name = 'fetch_page';

  constructor(@inject(DITokens.RETRIEVAL_SERVICE) private retrievalService: RetrievalService) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const url = call.parameters?.url as string | undefined;
    const title = (call.parameters?.title as string | undefined) ?? url ?? '无标题';

    if (!url) {
      return this.error('请提供 URL', 'Missing required parameter: url');
    }

    const fetchService = this.retrievalService.getPageContentFetchService();
    if (!fetchService.isEnabled()) {
      logger.info('[FetchPageToolExecutor] Page fetch is not enabled (config)');
      return this.error('页面抓取功能未开启', 'fetch_page is disabled by config');
    }

    logger.info(`[FetchPageToolExecutor] Fetching page: ${url}`);

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
