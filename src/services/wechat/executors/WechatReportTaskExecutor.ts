// WechatReportTaskExecutor - generates and saves comprehensive WeChat reports
// Used by AgentLoop to create daily/weekly/monthly reports

import { inject, injectable } from 'tsyringe';
import { getStaticFileServer } from '@/services/staticServer';
import { WechatDITokens } from '@/services/wechat';
import type { ReportType, WechatReportService } from '@/services/wechat/WechatReportService';
import { TaskDefinition } from '@/task/decorators';
import { BaseTaskExecutor } from '@/task/executors/BaseTaskExecutor';
import type { Task, TaskExecutionContext, TaskResult } from '@/task/types';
import { logger } from '@/utils/logger';

/**
 * WechatReportTaskExecutor
 *
 * Generates comprehensive WeChat reports combining stats, group summaries,
 * and article recommendations. Reports are automatically saved to disk.
 *
 * Usage in schedule.md:
 * ```markdown
 * ## 微信日报
 * - 触发: `cron 0 22 * * *`
 * - 群: `123456789`
 * - 步数: `3`
 *
 * 生成今日微信日报：
 * 1. 调用 wechat_report 生成并保存日报
 * 2. 将报告要点整理成简洁的消息发送到群里
 * ```
 */
@TaskDefinition({
  name: 'wechat_report',
  description: '生成并保存微信报告。自动收集群聊摘要、文章推荐、统计数据，生成格式化报告并保存到文件。',
  executor: 'wechat_report',
  parameters: {
    reportType: {
      type: 'string',
      required: false,
      description: '报告类型：daily(日报)、weekly(周报)、monthly(月报)。默认 daily。',
    },
    sinceHours: {
      type: 'number',
      required: false,
      description: '自定义时间范围（小时）。指定后会覆盖 reportType 的默认时间范围。',
    },
    includeStats: {
      type: 'boolean',
      required: false,
      description: '是否包含统计数据。默认 true。',
    },
    includeGroups: {
      type: 'boolean',
      required: false,
      description: '是否包含群聊摘要。默认 true。',
    },
    includeArticles: {
      type: 'boolean',
      required: false,
      description: '是否包含文章推荐。默认 true。',
    },
    maxGroups: {
      type: 'number',
      required: false,
      description: '最多显示多少个群的详细摘要。默认 5。',
    },
    maxArticles: {
      type: 'number',
      required: false,
      description: '最多显示多少篇文章。默认 10。',
    },
  },
  examples: ['生成微信日报', '生成本周微信报告', '生成微信月报'],
  whenToUse: '当需要生成综合性微信报告时使用。报告会自动保存到 data/reports/wechat/ 目录。',
})
@injectable()
export class WechatReportTaskExecutor extends BaseTaskExecutor {
  name = 'wechat_report';

  constructor(@inject(WechatDITokens.REPORT_SERVICE) private reportService: WechatReportService) {
    super();
  }

  async execute(task: Task, _context: TaskExecutionContext): Promise<TaskResult> {
    const reportType = (task.parameters?.reportType as ReportType) ?? 'daily';
    const sinceHours = task.parameters?.sinceHours as number | undefined;
    const includeStats = task.parameters?.includeStats as boolean | undefined;
    const includeGroups = task.parameters?.includeGroups as boolean | undefined;
    const includeArticles = task.parameters?.includeArticles as boolean | undefined;
    const maxGroups = task.parameters?.maxGroups as number | undefined;
    const maxArticles = task.parameters?.maxArticles as number | undefined;

    logger.info(
      `[WechatReportTaskExecutor] Generating ${reportType} report | ` +
        `sinceHours=${sinceHours ?? 'auto'} stats=${includeStats ?? true}`,
    );

    try {
      // Generate and save report
      const metadata = this.reportService.generateAndSave({
        type: reportType,
        sinceHours,
        includeStats: includeStats ?? true,
        includeGroups: includeGroups ?? true,
        includeArticles: includeArticles ?? true,
        maxGroupsToShow: maxGroups ?? 5,
        maxArticlesToShow: maxArticles ?? 10,
      });

      // Generate report URL for webui
      let reportUrl: string | null = null;
      try {
        const staticServer = getStaticFileServer();
        // Use webui base URL (same host, port 5173) instead of static server URL
        const staticUrl = new URL(staticServer.getBaseURL());
        const baseUrl = `${staticUrl.protocol}//${staticUrl.hostname}:5173`;
        reportUrl = this.reportService.getReportUrl(metadata.id, baseUrl);
      } catch {
        // Static file server may not be available
        logger.debug('[WechatReportTaskExecutor] Could not generate report URL (static server not available)');
      }

      logger.info(
        `[WechatReportTaskExecutor] Report generated | ` +
          `id=${metadata.id} url=${reportUrl ?? 'N/A'} messages=${metadata.stats.totalMessages}`,
      );

      // Return a summary for LLM with URL, plus metadata in data
      const summary = this.buildSummary(metadata, reportUrl);

      return this.success(summary, {
        reportId: metadata.id,
        reportType: metadata.type,
        reportUrl,
        filePath: metadata.filePath,
        period: metadata.period,
        stats: metadata.stats,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('[WechatReportTaskExecutor] Error:', err);
      return this.error('生成报告失败', errorMsg);
    }
  }

  private buildSummary(
    metadata: import('@/services/wechat/WechatReportService').ReportMetadata,
    reportUrl: string | null,
  ): string {
    const lines = [
      `## 报告已生成`,
      '',
      `- **类型**: ${this.getTypeLabel(metadata.type)}`,
      `- **时间范围**: ${metadata.period}`,
      `- **生成时间**: ${new Date(metadata.generatedAt).toLocaleString('zh-CN')}`,
    ];

    // Add report URL if available (preferred way to view)
    if (reportUrl) {
      lines.push(`- **查看报告**: ${reportUrl}`);
    }

    lines.push(
      '',
      '### 数据概览',
      `- 总消息数: ${metadata.stats.totalMessages}`,
      `- 总文章数: ${metadata.stats.totalArticles}`,
      `- 活跃群数: ${metadata.stats.groupCount}`,
    );

    if (reportUrl) {
      lines.push('', `> 点击链接查看完整报告的富文本版本: ${reportUrl}`);
    }

    return lines.join('\n');
  }

  private getTypeLabel(type: ReportType): string {
    switch (type) {
      case 'daily':
        return '日报';
      case 'weekly':
        return '周报';
      case 'monthly':
        return '月报';
      default:
        return '报告';
    }
  }
}
