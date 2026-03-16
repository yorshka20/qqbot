// WechatDigestTaskExecutor - retrieves daily WeChat message summaries
// Used by Agenda cron jobs to generate daily reports

import { inject, injectable } from 'tsyringe';
import { WechatDITokens } from '@/services/wechat';
import type { WechatDigestService } from '@/services/wechat/WechatDigestService';
import { logger } from '@/utils/logger';
import { TaskDefinition } from '../decorators';
import type { Task, TaskExecutionContext, TaskResult } from '../types';
import { BaseTaskExecutor } from './BaseTaskExecutor';

/**
 * WechatDigestTaskExecutor
 *
 * Retrieves unprocessed WeChat messages from the database, formats them
 * as a grouped summary, and optionally marks them as processed.
 *
 * Usage in schedule.md:
 * ```markdown
 * ## 微信日报
 * - 触发: `cron 0 22 * * *`
 * - 群: `123456789`
 *
 * 生成今日微信消息日报。
 * 1. 调用 wechat_digest 工具获取今日所有未处理的微信消息
 * 2. 按来源逐个总结要点
 * ```
 */
@TaskDefinition({
  name: 'wechat_digest',
  description: '获取今日微信消息摘要。返回按来源分组的消息列表，包含消息数量统计。可用于生成日报或定期汇总。',
  executor: 'wechat_digest',
  parameters: {
    markProcessed: {
      type: 'boolean',
      required: false,
      description: '是否将消息标记为已处理，避免重复摘要。默认 true。',
    },
    sinceHours: {
      type: 'number',
      required: false,
      description: '查询过去多少小时的消息。默认从今天0点开始。',
    },
  },
  examples: ['获取今日微信消息摘要', '查看微信消息日报', '汇总今天的微信消息'],
  whenToUse: '当需要查看、汇总、分析今日微信消息时使用。适用于每日定时汇报。',
})
@injectable()
export class WechatDigestTaskExecutor extends BaseTaskExecutor {
  name = 'wechat_digest';

  constructor(@inject(WechatDITokens.DIGEST_SERVICE) private digestService: WechatDigestService) {
    super();
  }

  async execute(task: Task, _context: TaskExecutionContext): Promise<TaskResult> {
    const markProcessed = task.parameters?.markProcessed !== false;
    const sinceHours = task.parameters?.sinceHours as number | undefined;

    // Calculate since timestamp
    let sinceTs: number | undefined;
    if (sinceHours && sinceHours > 0) {
      sinceTs = Math.floor(Date.now() / 1000) - sinceHours * 3600;
    }

    logger.info(
      `[WechatDigestTaskExecutor] Getting digest | sinceHours=${sinceHours ?? 'today'} markProcessed=${markProcessed}`,
    );

    try {
      const digest = await this.digestService.getUnprocessedDigest(sinceTs);

      if (digest.totalCount === 0) {
        return this.success('今日暂无未处理的微信消息。', {
          totalCount: 0,
          sourceBreakdown: [],
          markedProcessed: false,
        });
      }

      // Mark as processed if requested
      let markedCount = 0;
      if (markProcessed) {
        markedCount = this.digestService.markProcessed(sinceTs);
      }

      logger.info(
        `[WechatDigestTaskExecutor] Digest complete | total=${digest.totalCount} sources=${digest.sourceBreakdown.length} marked=${markedCount}`,
      );

      return this.success(digest.groupedText, {
        totalCount: digest.totalCount,
        sourceBreakdown: digest.sourceBreakdown,
        markedProcessed: markProcessed,
        markedCount,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('[WechatDigestTaskExecutor] Error:', err);
      return this.error('获取微信摘要失败', errorMsg);
    }
  }
}
