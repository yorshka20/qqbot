// ZhihuDigestToolExecutor — retrieves zhihu feed data for AgentLoop.
// Returns raw feed data as structured text; LLM summarization is done by AgentLoop.

import { inject, injectable } from 'tsyringe';
import { ZhihuDITokens } from '@/services/zhihu/tokens';
import type { ZhihuFeedItemRow } from '@/services/zhihu/types';
import type { ZhihuFeedService } from '@/services/zhihu/ZhihuFeedService';
import { Tool } from '@/tools/decorators';
import { BaseToolExecutor } from '@/tools/executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';

@Tool({
  name: 'zhihu_digest',
  description: '获取知乎关注动态数据。返回最近N小时的知乎feed，包含标题、作者、赞同数、评论数、摘要、链接等。调用后会自动将这些动态标记为已处理。',
  executor: 'zhihu_digest',
  visibility: ['subagent'],
  parameters: {
    hoursBack: {
      type: 'number',
      required: false,
      description: '回溯的小时数，默认24小时。',
    },
  },
  examples: ['获取知乎动态数据', '获取最近12小时的知乎动态'],
  whenToUse: '当需要获取知乎关注动态数据以生成摘要或报告时使用。',
})
@injectable()
export class ZhihuDigestToolExecutor extends BaseToolExecutor {
  name = 'zhihu_digest';

  constructor(@inject(ZhihuDITokens.ZHIHU_FEED_SERVICE) private feedService: ZhihuFeedService) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const hoursBack = (call.parameters?.hoursBack as number) ?? 24;
    const sinceTs = Math.floor(Date.now() / 1000) - hoursBack * 3600;

    logger.info(`[ZhihuDigestToolExecutor] Fetching feed data for last ${hoursBack}h`);

    try {
      const items = this.feedService.getUndigestedSince(sinceTs);

      if (items.length === 0) {
        return this.success(`过去 ${hoursBack} 小时没有新的知乎动态。`);
      }

      const text = this.formatItems(items, hoursBack);

      // Mark items as digested so they won't appear in future digests
      const itemIds = items.map((i) => i.id);
      this.feedService.markDigested(itemIds);

      logger.info(`[ZhihuDigestToolExecutor] Returned ${items.length} items, ${text.length} chars`);
      return this.success(text, { itemCount: items.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[ZhihuDigestToolExecutor] Error:', err);
      return this.error('获取知乎动态数据失败', msg);
    }
  }

  private formatItems(items: ZhihuFeedItemRow[], hoursBack: number): string {
    const lines = items.map((item) => {
      const verb = this.getVerbLabel(item.verb);
      const excerpt = item.excerpt ? item.excerpt.slice(0, 200) : '';
      return `- [${verb}] ${item.title} — ${item.authorName}\n  赞同: ${item.voteupCount} | 评论: ${item.commentCount}\n  摘要: ${excerpt}\n  链接: ${item.url}`;
    });

    return `以下是过去 ${hoursBack} 小时的知乎关注动态（共 ${items.length} 条）：\n\n${lines.join('\n\n')}`;
  }

  private getVerbLabel(verb: string): string {
    switch (verb) {
      case 'ANSWER_CREATE':
        return '新回答';
      case 'ARTICLE_CREATE':
        return '新文章';
      case 'ANSWER_VOTE_UP':
      case 'MEMBER_VOTEUP_ANSWER':
        return '赞同回答';
      case 'MEMBER_VOTEUP_ARTICLE':
        return '赞同文章';
      case 'MEMBER_ANSWER_QUESTION':
        return '回答问题';
      case 'MEMBER_FOLLOW_QUESTION':
      case 'QUESTION_FOLLOW':
        return '关注问题';
      case 'ZVIDEO_CREATE':
        return '新视频';
      default:
        return verb;
    }
  }
}
