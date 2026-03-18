// WeChat article analysis tool — triggers LLM analysis on recent articles via Ollama

import { inject, injectable } from 'tsyringe';
import { WechatDITokens } from '@/services/wechat/tokens';
import type { WeChatArticleAnalysisService } from '@/services/wechat/WeChatArticleAnalysisService';
import { Tool } from '@/tools/decorators';
import { BaseToolExecutor } from '@/tools/executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';

const DEFAULT_HOURS = 24;

@Tool({
  name: 'wechat_analyze_articles',
  description:
    '对近期收录的微信公众号文章执行 LLM 深度分析。' +
    '会逐篇获取文章原文，调用本地 Ollama 模型提取事实、新闻、观点和洞察，将结果存入数据库。' +
    '分析完成后可通过 wechat_article_insights 工具查看提取结果。' +
    '注意：此操作耗时较长（每篇文章数秒到数十秒），建议在非高峰时段运行。',
  executor: 'wechat_analyze_articles',
  parameters: {
    sinceHours: {
      type: 'number',
      required: false,
      description: `分析过去多少小时内收到的文章，默认 ${DEFAULT_HOURS}`,
    },
  },
  examples: [
    '分析今天收到的微信文章',
    '对过去 48 小时的公众号文章做深度提取',
  ],
  whenToUse:
    '当需要对微信文章进行批量深度分析时使用。通常由定时任务在夜间自动调用。' +
    '已分析过的文章会自动跳过，可安全重复调用。',
})
@injectable()
export class WechatAnalyzeArticlesToolExecutor extends BaseToolExecutor {
  name = 'wechat_analyze_articles';

  constructor(
    @inject(WechatDITokens.ARTICLE_ANALYSIS_SERVICE)
    private analysisService: WeChatArticleAnalysisService,
  ) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const sinceHours =
      typeof call.parameters?.sinceHours === 'number' && Number.isFinite(call.parameters.sinceHours)
        ? call.parameters.sinceHours
        : DEFAULT_HOURS;

    const sinceTs = Math.floor(Date.now() / 1000) - sinceHours * 3600;

    logger.info(`[WechatAnalyzeArticles] Starting analysis for past ${sinceHours}h`);

    try {
      const result = await this.analysisService.analyzeArticles(sinceTs);

      const summary = [
        `文章分析完成：`,
        `  总文章数: ${result.total}`,
        `  已跳过（此前已分析）: ${result.skipped}`,
        `  本次分析: ${result.analyzed}`,
        `  值得报道: ${result.worthReporting}`,
        result.failed > 0 ? `  分析失败: ${result.failed}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      return this.success(summary, {
        sinceHours,
        ...result,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('[WechatAnalyzeArticles] Error:', err);
      return this.error('文章分析失败', errorMsg);
    }
  }
}
