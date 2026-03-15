// WechatArticleSummaryTaskExecutor - retrieves article/link summaries
// Used by Agenda to generate article reports or analyze shared content

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { WechatDigestService } from '@/services/wechat/WechatDigestService';
import { logger } from '@/utils/logger';
import { TaskDefinition } from '../decorators';
import type { Task, TaskExecutionContext, TaskResult } from '../types';
import { BaseTaskExecutor } from './BaseTaskExecutor';

/**
 * WechatArticleSummaryTaskExecutor
 *
 * Retrieves article summaries from WeChat. Supports filtering by source type
 * (official account push vs shared in chat) and keyword search.
 *
 * Usage in schedule.md:
 * ```markdown
 * ## 公众号文章日报
 * - 触发: `cron 0 21 * * *`
 * - 群: `123456789`
 *
 * 1. 调用 wechat_article_summary 获取今日收到的文章
 * 2. 挑选值得阅读的文章，生成推荐列表
 * ```
 */
@TaskDefinition({
  name: 'wechat_article_summary',
  description: '获取微信文章摘要。包括公众号推送和聊天中分享的链接。返回标题、来源、摘要等信息。',
  executor: 'wechat_article_summary',
  parameters: {
    sourceType: {
      type: 'string',
      required: false,
      description: '来源类型：oa_push(公众号推送)、group_chat(群聊分享)、private_chat(私聊分享)、all(全部)。默认 all。',
    },
    keyword: {
      type: 'string',
      required: false,
      description: '关键词过滤，匹配标题、摘要或公众号名称。',
    },
    sinceHours: {
      type: 'number',
      required: false,
      description: '查询过去多少小时的文章。默认从今天0点开始。',
    },
    limit: {
      type: 'number',
      required: false,
      description: '最多返回多少篇文章。默认100篇。',
    },
  },
  examples: ['获取今日公众号文章', '查看收到的文章', '搜索关于AI的文章'],
  whenToUse: '当需要查看、分析微信收到的文章时使用。适用于文章日报或特定话题的文章筛选。',
})
@injectable()
export class WechatArticleSummaryTaskExecutor extends BaseTaskExecutor {
  name = 'wechat_article_summary';

  constructor(@inject(DITokens.WECHAT_DIGEST_SERVICE) private digestService: WechatDigestService) {
    super();
  }

  async execute(task: Task, _context: TaskExecutionContext): Promise<TaskResult> {
    const sourceType = task.parameters?.sourceType as 'oa_push' | 'group_chat' | 'private_chat' | 'all' | undefined;
    const keyword = task.parameters?.keyword as string | undefined;
    const sinceHours = task.parameters?.sinceHours as number | undefined;
    const limit = task.parameters?.limit as number | undefined;

    // Calculate since timestamp
    let sinceTs: number | undefined;
    if (sinceHours && sinceHours > 0) {
      sinceTs = Math.floor(Date.now() / 1000) - sinceHours * 3600;
    }

    logger.info(
      `[WechatArticleSummaryTaskExecutor] Getting articles | ` +
        `sourceType=${sourceType ?? 'all'} keyword=${keyword ?? 'none'} sinceHours=${sinceHours ?? 'today'}`,
    );

    try {
      const articles = this.digestService.getArticleSummaries({
        sinceTs,
        sourceType: sourceType ?? 'all',
        keyword,
        limit: limit ?? 100,
      });

      if (articles.length === 0) {
        const msg = keyword ? `未找到与 "${keyword}" 相关的文章。` : '暂无文章。';
        return this.success(msg, {
          articleCount: 0,
          articles: [],
        });
      }

      const text = this.digestService.getArticleSummaryText({
        sinceTs,
        sourceType: sourceType ?? 'all',
        keyword,
        limit: limit ?? 100,
      });

      logger.info(`[WechatArticleSummaryTaskExecutor] Found ${articles.length} articles`);

      return this.success(text, {
        articleCount: articles.length,
        articles: articles.map((a) => ({
          title: a.title,
          url: a.url,
          source: a.accountNick,
          sourceType: a.sourceType,
          summary: a.summary,
        })),
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('[WechatArticleSummaryTaskExecutor] Error:', err);
      return this.error('获取文章摘要失败', errorMsg);
    }
  }
}
