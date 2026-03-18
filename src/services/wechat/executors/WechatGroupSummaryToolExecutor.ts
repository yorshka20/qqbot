// WechatGroupSummaryToolExecutor - retrieves group chat message summaries
// Used by Agenda to generate group-specific reports

import { inject, injectable } from 'tsyringe';
import { WechatDITokens } from '@/services/wechat';
import type { WechatDigestService } from '@/services/wechat/WechatDigestService';
import { Tool } from '@/tools/decorators';
import { BaseToolExecutor } from '@/tools/executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';

/**
 * WechatGroupSummaryToolExecutor
 *
 * Retrieves group chat message summaries. Can filter by specific group
 * or get all groups. Returns formatted text ready for LLM processing.
 *
 * Usage in schedule.md:
 * ```markdown
 * ## 群聊日报
 * - 触发: `cron 0 22 * * *`
 * - 群: `123456789`
 *
 * 1. 调用 wechat_group_summary 获取今日群聊消息
 * 2. 总结每个群的讨论要点
 * ```
 */
@Tool({
  name: 'wechat_group_summary',
  description: '获取微信群聊消息摘要。返回按群分组的消息列表，包含发言人、消息数量等统计信息。',
  executor: 'wechat_group_summary',
  visibility: ['internal'],
  parameters: {
    conversationId: {
      type: 'string',
      required: false,
      description: '指定群ID。不指定则返回所有群的摘要。',
    },
    sinceHours: {
      type: 'number',
      required: false,
      description: '查询过去多少小时的消息。默认从今天0点开始。',
    },
    maxMessagesPerGroup: {
      type: 'number',
      required: false,
      description: '每个群最多返回多少条消息。默认50条。',
    },
  },
  examples: ['获取今日群聊消息', '查看群聊摘要', '总结今天的群消息'],
  whenToUse: '当需要查看、汇总微信群聊消息时使用。适用于群聊日报或特定群的消息回顾。',
})
@injectable()
export class WechatGroupSummaryToolExecutor extends BaseToolExecutor {
  name = 'wechat_group_summary';

  constructor(@inject(WechatDITokens.DIGEST_SERVICE) private digestService: WechatDigestService) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const conversationId = call.parameters?.conversationId as string | undefined;
    const sinceHours = call.parameters?.sinceHours as number | undefined;
    const maxMessagesPerGroup = call.parameters?.maxMessagesPerGroup as number | undefined;

    // Calculate since timestamp
    let sinceTs: number | undefined;
    if (sinceHours && sinceHours > 0) {
      sinceTs = Math.floor(Date.now() / 1000) - sinceHours * 3600;
    }

    logger.info(
      `[WechatGroupSummaryToolExecutor] Getting group summary | ` +
        `conversationId=${conversationId ?? 'all'} sinceHours=${sinceHours ?? 'today'}`,
    );

    try {
      const summaries = this.digestService.getGroupSummaries(sinceTs, conversationId, maxMessagesPerGroup ?? 50);

      if (summaries.length === 0) {
        return this.success('暂无群聊消息。', {
          groupCount: 0,
          totalMessages: 0,
        });
      }

      const text = this.digestService.getGroupSummaryText(sinceTs, conversationId);
      const totalMessages = summaries.reduce((sum, s) => sum + s.messageCount, 0);

      logger.info(
        `[WechatGroupSummaryToolExecutor] Summary complete | groups=${summaries.length} messages=${totalMessages}`,
      );

      return this.success(text, {
        groupCount: summaries.length,
        totalMessages,
        groups: summaries.map((s) => ({
          conversationId: s.conversationId,
          messageCount: s.messageCount,
          senderCount: s.senderCount,
          senders: s.senders,
          categories: s.categories,
        })),
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('[WechatGroupSummaryToolExecutor] Error:', err);
      return this.error('获取群聊摘要失败', errorMsg);
    }
  }
}
