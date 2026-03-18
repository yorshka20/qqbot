// WeChat article insights tool — retrieves LLM-analyzed article insights from DB

import { inject, injectable } from 'tsyringe';
import { WechatDITokens } from '@/services/wechat/tokens';
import type { WeChatDatabase } from '@/services/wechat/WeChatDatabase';
import { Tool } from '@/tools/decorators';
import { BaseToolExecutor } from '@/tools/executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';

const DEFAULT_HOURS = 24;
const DEFAULT_LIMIT = 50;

@Tool({
  name: 'wechat_article_insights',
  description:
    '获取经过 LLM 分析提取的微信文章精华内容。' +
    '返回的是已经从原文提炼出的关键事实、新闻、观点和洞察，按重要程度排列。' +
    '每条包含标题、一句话概括、分类标签、以及具体的信息点列表。' +
    '适用于生成日报、了解今日资讯概览、按领域查看文章精华。',
  executor: 'wechat_article_insights',
  parameters: {
    sinceHours: {
      type: 'number',
      required: false,
      description: `获取过去多少小时的分析结果，默认 ${DEFAULT_HOURS}`,
    },
    limit: {
      type: 'number',
      required: false,
      description: `最大返回条数，默认 ${DEFAULT_LIMIT}`,
    },
    worthOnly: {
      type: 'boolean',
      required: false,
      description: '是否只返回值得报道的文章（过滤广告/软文），默认 true',
    },
  },
  examples: ['获取今日微信文章的分析精华', '查看过去 48 小时的文章洞察', '生成日报时获取文章素材'],
  whenToUse:
    '当需要生成微信日报/周报、了解今日资讯概览、或获取文章分析结果时使用。' +
    '此工具返回的是已经由 LLM 预处理过的精炼内容，比直接搜索文章更适合用于报告生成。',
})
@injectable()
export class WechatInsightsToolExecutor extends BaseToolExecutor {
  name = 'wechat_article_insights';

  constructor(@inject(WechatDITokens.WECHAT_DB) private db: WeChatDatabase) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const sinceHours =
      typeof call.parameters?.sinceHours === 'number' && Number.isFinite(call.parameters.sinceHours)
        ? call.parameters.sinceHours
        : DEFAULT_HOURS;
    const limit =
      typeof call.parameters?.limit === 'number' && Number.isFinite(call.parameters.limit)
        ? Math.max(1, Math.floor(call.parameters.limit))
        : DEFAULT_LIMIT;
    const worthOnly = call.parameters?.worthOnly !== false;

    const sinceTs = Math.floor(Date.now() / 1000) - sinceHours * 3600;

    logger.info(`[WechatInsights] sinceHours=${sinceHours} limit=${limit} worthOnly=${worthOnly}`);

    try {
      const insights = this.db.getArticleInsights({
        sinceTs,
        worthOnly,
        limit,
      });

      if (insights.length === 0) {
        return this.success('当前时间范围内没有已分析的文章内容。', {
          sinceHours,
          resultCount: 0,
        });
      }

      const formatted = insights
        .map((row, index) => {
          const tags = JSON.parse(row.categoryTags) as string[];
          const items = JSON.parse(row.items) as Array<{
            type: string;
            content: string;
            tags: string[];
            importance: string;
          }>;

          const header = `${index + 1}. 「${row.title}」\n   来源: ${row.source} | 分类: ${tags.join(', ')} | 概括: ${row.headline}`;

          if (items.length === 0) return header;

          const itemsText = items
            .map((item) => {
              const imp = item.importance === 'high' ? '★' : item.importance === 'medium' ? '●' : '○';
              return `   ${imp} [${item.type}] ${item.content}`;
            })
            .join('\n');

          return `${header}\n${itemsText}`;
        })
        .join('\n\n');

      return this.success(formatted, {
        sinceHours,
        resultCount: insights.length,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('[WechatInsights] Error:', err);
      return this.error('获取文章分析结果失败', errorMsg);
    }
  }
}
