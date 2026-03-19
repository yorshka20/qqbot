// WeChat article analysis tool — triggers LLM analysis on recent articles via Ollama

import { inject, injectable } from 'tsyringe';
import type { WeChatArticleAnalysisService } from '@/services/wechat/articles/WeChatArticleAnalysisService';
import { WechatDITokens } from '@/services/wechat/tokens';
import { Tool } from '@/tools/decorators';
import { BaseToolExecutor } from '@/tools/executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';

const DEFAULT_COUNT = 100;

@Tool({
  name: 'wechat_analyze_articles',
  description:
    '对未分析过的微信公众号文章执行 LLM 深度分析。' +
    '从最新文章开始往回扫描，自动跳过已分析的文章。' +
    '调用本地 Ollama 模型提取事实、新闻、观点和洞察，将结果存入数据库。' +
    '分析完成后可通过 wechat_article_insights 工具查看提取结果。' +
    '注意：此操作耗时较长（每篇文章数秒到数十秒），建议在非高峰时段运行。',
  executor: 'wechat_analyze_articles',
  parameters: {
    count: {
      type: 'number',
      required: false,
      description: `本次最多分析多少篇文章，默认 ${DEFAULT_COUNT}`,
    },
  },
  examples: ['分析未处理的微信文章', '分析最近50篇未分析的公众号文章'],
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
    const count =
      typeof call.parameters?.count === 'number' && Number.isFinite(call.parameters.count) && call.parameters.count > 0
        ? call.parameters.count
        : DEFAULT_COUNT;

    logger.info(`[WechatAnalyzeArticles] Starting analysis for up to ${count} unanalyzed articles`);

    try {
      const result = await this.analysisService.analyzeArticles(count);

      const summary = [
        `文章分析完成：`,
        `  待分析文章数: ${result.total}`,
        `  本次分析: ${result.analyzed}`,
        `  值得报道: ${result.worthReporting}`,
        result.failed > 0 ? `  分析失败: ${result.failed}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      return this.success(summary, {
        count,
        ...result,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('[WechatAnalyzeArticles] Error:', err);
      return this.error('文章分析失败', errorMsg);
    }
  }
}
