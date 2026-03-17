// WechatStatsTaskExecutor - retrieves overall WeChat statistics
// Used by Agenda to generate daily/weekly statistics reports

import { inject, injectable } from 'tsyringe';
import { WechatDITokens } from '@/services/wechat';
import type { WechatDigestService } from '@/services/wechat/WechatDigestService';
import { TaskDefinition } from '@/task/decorators';
import { BaseTaskExecutor } from '@/task/executors/BaseTaskExecutor';
import type { Task, TaskExecutionContext, TaskResult } from '@/task/types';
import { logger } from '@/utils/logger';

/**
 * WechatStatsTaskExecutor
 *
 * Retrieves comprehensive WeChat statistics including message counts,
 * group activity, article counts, and top contributors.
 *
 * Usage in schedule.md:
 * ```markdown
 * ## 微信周报
 * - 触发: `cron 0 20 * * 0`
 * - 群: `123456789`
 *
 * 1. 调用 wechat_stats 获取本周统计数据
 * 2. 生成一份简洁的周报，包含活跃群聊、热门文章等
 * ```
 */
@TaskDefinition({
  name: 'wechat_stats',
  description: '获取微信消息统计。包括消息总数、群聊/私聊分布、文章数量、活跃群聊排行、活跃公众号排行等。',
  executor: 'wechat_stats',
  parameters: {
    sinceHours: {
      type: 'number',
      required: false,
      description: '统计过去多少小时的数据。默认从今天0点开始。可设置168小时获取一周数据。',
    },
  },
  examples: ['获取今日微信统计', '查看微信消息统计', '微信使用情况汇总'],
  whenToUse: '当需要了解微信消息整体情况时使用。适用于日报、周报或数据分析。',
})
@injectable()
export class WechatStatsTaskExecutor extends BaseTaskExecutor {
  name = 'wechat_stats';

  constructor(@inject(WechatDITokens.DIGEST_SERVICE) private digestService: WechatDigestService) {
    super();
  }

  async execute(task: Task, _context: TaskExecutionContext): Promise<TaskResult> {
    const sinceHours = task.parameters?.sinceHours as number | undefined;

    // Calculate since timestamp
    let sinceTs: number | undefined;
    if (sinceHours && sinceHours > 0) {
      sinceTs = Math.floor(Date.now() / 1000) - sinceHours * 3600;
    }

    logger.info(`[WechatStatsTaskExecutor] Getting stats | sinceHours=${sinceHours ?? 'today'}`);

    try {
      const stats = this.digestService.getStats(sinceTs);
      const text = this.digestService.getStatsText(sinceTs);

      logger.info(
        `[WechatStatsTaskExecutor] Stats complete | ` +
          `messages=${stats.messages.total} articles=${stats.articles.total}`,
      );

      return this.success(text, {
        period: stats.period,
        messages: stats.messages,
        articles: stats.articles,
        topGroups: stats.topGroups,
        topAccounts: stats.topAccounts,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('[WechatStatsTaskExecutor] Error:', err);
      return this.error('获取统计数据失败', errorMsg);
    }
  }
}
