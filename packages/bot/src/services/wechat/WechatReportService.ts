// WechatReportService - generates and stores comprehensive WeChat reports
// Orchestrates data collection and formats reports for storage
// Reports are saved as structured JSON for rich frontend rendering

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '@/utils/logger';
import type { ArticleSummary, GroupSummary, WechatDigestService, WechatStats } from './WechatDigestService';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type ReportType = 'daily' | 'weekly' | 'monthly' | 'custom';

export interface ReportOptions {
  type: ReportType;
  sinceHours?: number;
  includeStats?: boolean;
  includeGroups?: boolean;
  includeArticles?: boolean;
  includeSearch?: string;
  maxGroupsToShow?: number;
  maxArticlesToShow?: number;
}

export interface ReportMetadata {
  id: string;
  type: ReportType;
  generatedAt: string;
  period: string;
  filePath: string;
  stats: {
    totalMessages: number;
    totalArticles: number;
    groupCount: number;
  };
}

/** Structured report data for rich frontend rendering */
export interface StructuredReport {
  id: string;
  type: ReportType;
  title: string;
  generatedAt: string;
  period: {
    start: string;
    end: string;
    label: string;
  };
  stats: WechatStats | null;
  groups: GroupSummary[];
  articles: ArticleSummary[];
  markdownContent: string;
}

/** Full report file format (saved to disk) */
export interface ReportFile {
  version: 1;
  report: StructuredReport;
  metadata: ReportMetadata;
}

export interface GeneratedReport {
  content: string;
  metadata: ReportMetadata;
  structured: StructuredReport;
}

// ────────────────────────────────────────────────────────────────────────────
// WechatReportService
// ────────────────────────────────────────────────────────────────────────────

export class WechatReportService {
  private readonly reportDir: string;

  constructor(
    private digestService: WechatDigestService,
    reportDir = 'data/reports/wechat',
  ) {
    this.reportDir = resolve(reportDir);
    this.ensureDir(this.reportDir);
    logger.info(`[WechatReportService] Initialized | reportDir=${this.reportDir}`);
  }

  // ──────────────────────────────────────────────────
  // Report Generation
  // ──────────────────────────────────────────────────

  /**
   * Generate a comprehensive report with structured data.
   */
  generateReport(options: ReportOptions = { type: 'daily' }): GeneratedReport {
    const sinceTs = this.getSinceTs(options);
    const now = new Date();

    logger.info(
      `[WechatReportService] Generating ${options.type} report | ` +
        `sinceTs=${sinceTs} includeStats=${options.includeStats ?? true}`,
    );

    // Collect data
    const stats = options.includeStats !== false ? this.digestService.getStats(sinceTs) : null;
    const groups = options.includeGroups !== false ? this.digestService.getGroupSummaries(sinceTs, undefined, 0) : [];
    const articles =
      options.includeArticles !== false
        ? this.digestService.getArticleSummaries({ sinceTs, limit: options.maxArticlesToShow ?? 20 })
        : [];

    // Generate report content (markdown)
    const content = this.formatReport(options, stats, groups, articles, sinceTs);

    // Generate unique ID (short hash based on content + timestamp)
    const reportId = this.generateReportId(options.type, now, content);
    const fileName = `${reportId}.json`;
    const filePath = resolve(this.reportDir, fileName);

    // Build structured report
    const structured: StructuredReport = {
      id: reportId,
      type: options.type,
      title: `微信${this.getTypeLabel(options.type)} - ${now.toLocaleDateString('zh-CN')}`,
      generatedAt: now.toISOString(),
      period: {
        start: new Date(sinceTs * 1000).toISOString(),
        end: now.toISOString(),
        label: stats?.period ?? this.formatPeriod(sinceTs, now),
      },
      stats,
      groups: groups.slice(0, options.maxGroupsToShow ?? 10),
      articles: articles.slice(0, options.maxArticlesToShow ?? 10),
      markdownContent: content,
    };

    const metadata: ReportMetadata = {
      id: reportId,
      type: options.type,
      generatedAt: now.toISOString(),
      period: stats?.period ?? this.formatPeriod(sinceTs, now),
      filePath,
      stats: {
        totalMessages: stats?.messages.total ?? 0,
        totalArticles: stats?.articles.total ?? 0,
        groupCount: stats?.messages.groupCount ?? 0,
      },
    };

    return { content, metadata, structured };
  }

  /**
   * Generate and save a report to disk as structured JSON.
   */
  generateAndSave(options: ReportOptions = { type: 'daily' }): ReportMetadata {
    const report = this.generateReport(options);

    // Save as structured JSON
    this.ensureDir(dirname(report.metadata.filePath));
    const reportFile: ReportFile = {
      version: 1,
      report: report.structured,
      metadata: report.metadata,
    };
    writeFileSync(report.metadata.filePath, JSON.stringify(reportFile, null, 2), 'utf-8');

    logger.info(
      `[WechatReportService] Report saved | id=${report.metadata.id} path=${report.metadata.filePath} ` +
        `messages=${report.metadata.stats.totalMessages}`,
    );

    return report.metadata;
  }

  /**
   * Get a report by its ID.
   */
  getReportById(id: string): ReportFile | null {
    const filePath = resolve(this.reportDir, `${id}.json`);
    if (!existsSync(filePath)) return null;

    try {
      const content = readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as ReportFile;
    } catch {
      return null;
    }
  }

  /**
   * Get the structured data of the last generated report.
   */
  getLastReport(type: ReportType = 'daily'): ReportFile | null {
    const reports = this.listReportMetadata(type);
    if (reports.length === 0) return null;

    const lastReport = reports[reports.length - 1];
    if (!lastReport) return null;

    return this.getReportById(lastReport.id);
  }

  /**
   * Get the text content of the last generated report (for backward compatibility).
   */
  getLastReportContent(type: ReportType = 'daily'): string | null {
    const report = this.getLastReport(type);
    return report?.report.markdownContent ?? null;
  }

  /**
   * List all report metadata (without full content).
   */
  listReportMetadata(type?: ReportType): ReportMetadata[] {
    if (!existsSync(this.reportDir)) return [];

    const files = readdirSync(this.reportDir).filter((f) => f.endsWith('.json'));
    const reports: ReportMetadata[] = [];

    for (const file of files) {
      try {
        const filePath = resolve(this.reportDir, file);
        const content = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content) as ReportFile;

        if (type && data.metadata.type !== type) continue;

        reports.push(data.metadata);
      } catch {
        // Skip invalid files
      }
    }

    // Sort by generatedAt ascending
    return reports.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  }

  /**
   * List all reports of a given type (file paths for backward compatibility).
   */
  listReports(type?: ReportType): string[] {
    return this.listReportMetadata(type).map((m) => m.filePath);
  }

  /**
   * Generate a URL for accessing a report in the webui.
   * @param id Report ID
   * @param baseUrl Base URL of the static server (e.g., "http://localhost:8888")
   */
  getReportUrl(id: string, baseUrl: string): string {
    // URL format: {baseUrl}/#/report/{id}
    // The webui handles this hash route and fetches the report via API
    return `${baseUrl}/#/report/${id}`;
  }

  // ──────────────────────────────────────────────────
  // Report Formatting
  // ──────────────────────────────────────────────────

  private formatReport(
    options: ReportOptions,
    stats: WechatStats | null,
    groups: GroupSummary[],
    articles: ArticleSummary[],
    sinceTs: number,
  ): string {
    const sections: string[] = [];
    const now = new Date();
    const typeLabel = this.getTypeLabel(options.type);

    // Header
    sections.push(
      `# 微信${typeLabel} - ${now.toLocaleDateString('zh-CN')}`,
      '',
      `> 报告生成时间: ${now.toLocaleString('zh-CN')}`,
      `> 统计范围: ${this.formatPeriod(sinceTs, now)}`,
      '',
    );

    // Stats section
    if (stats) {
      sections.push(
        '## 📊 数据概览',
        '',
        '### 消息统计',
        `- **总消息数**: ${stats.messages.total}`,
        `- **群聊消息**: ${stats.messages.groups} (来自 ${stats.messages.groupCount} 个群)`,
        `- **私聊消息**: ${stats.messages.private} (来自 ${stats.messages.privateCount} 个联系人)`,
        '',
        '### 文章统计',
        `- **总文章数**: ${stats.articles.total}`,
        `- **公众号推送**: ${stats.articles.oaPush}`,
        `- **聊天分享**: ${stats.articles.shared}`,
        '',
      );

      // Top groups
      if (stats.topGroups.length > 0) {
        sections.push('### 活跃群聊 Top 10');
        for (let i = 0; i < Math.min(stats.topGroups.length, 10); i++) {
          const g = stats.topGroups[i];
          if (!g) continue;
          const groupName = this.digestService.resolveGroupName(g.conversationId);
          sections.push(`${i + 1}. **${groupName}**: ${g.messageCount} 条消息, ${g.senderCount} 人参与`);
        }
        sections.push('');
      }

      // Top accounts
      if (stats.topAccounts.length > 0) {
        sections.push('### 活跃公众号 Top 10');
        for (let i = 0; i < Math.min(stats.topAccounts.length, 10); i++) {
          const a = stats.topAccounts[i];
          if (!a) continue;
          sections.push(`${i + 1}. **${a.accountNick}**: ${a.articleCount} 篇文章`);
        }
        sections.push('');
      }
    }

    // Groups section
    if (groups.length > 0) {
      sections.push('---', '', '## 💬 群聊摘要', '');

      const maxGroups = options.maxGroupsToShow ?? 5;
      const showGroups = groups.slice(0, maxGroups);

      for (const g of showGroups) {
        const groupName = this.digestService.resolveGroupName(g.conversationId);
        sections.push(
          `### ${groupName}`,
          `> ${g.messageCount} 条消息 | ${g.senderCount} 人发言 | 类型: ${g.categories.join(', ')}`,
          '',
          '```',
          g.formattedMessages,
          '```',
          '',
        );
      }

      if (groups.length > maxGroups) {
        sections.push(`> 还有 ${groups.length - maxGroups} 个群的消息未显示`, '');
      }
    }

    // Articles section
    if (articles.length > 0) {
      sections.push('---', '', '## 📰 文章推荐', '');

      const maxArticles = options.maxArticlesToShow ?? 10;
      const showArticles = articles.slice(0, maxArticles);

      for (const a of showArticles) {
        const sourceLabel =
          a.sourceType === 'oa_push' ? `公众号: ${a.accountNick}` : `分享自: ${a.sharedBy || 'unknown'}`;

        sections.push(
          `### ${a.title}`,
          `> ${sourceLabel}`,
          '',
          a.summary ? `${this.truncate(a.summary, 200)}` : '',
          '',
          `🔗 [阅读原文](${a.url})`,
          '',
        );
      }

      if (articles.length > maxArticles) {
        sections.push(`> 还有 ${articles.length - maxArticles} 篇文章未显示`, '');
      }
    }

    // Footer
    sections.push('---', '', `*本报告由 QQBot 自动生成 | ${now.toISOString()}*`);

    return sections.join('\n');
  }

  // ──────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────

  private getSinceTs(options: ReportOptions): number {
    if (options.sinceHours && options.sinceHours > 0) {
      return Math.floor(Date.now() / 1000) - options.sinceHours * 3600;
    }

    const now = new Date();
    switch (options.type) {
      case 'daily':
        return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
      case 'weekly': {
        const weekStart = new Date(now);
        weekStart.setDate(weekStart.getDate() - 7);
        weekStart.setHours(0, 0, 0, 0);
        return Math.floor(weekStart.getTime() / 1000);
      }
      case 'monthly': {
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        return Math.floor(monthStart.getTime() / 1000);
      }
      default:
        return this.digestService.getTodayStartTs();
    }
  }

  /**
   * Generate a unique report ID based on type, date, and content hash.
   * Format: {type}_{date}_{shortHash} (e.g., "daily_2026-03-15_a1b2c3d4")
   */
  private generateReportId(type: ReportType, date: Date, content: string): string {
    const dateStr = date.toISOString().slice(0, 10);
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
    return `${type}_${dateStr}_${hash}`;
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

  private formatPeriod(sinceTs: number, until: Date): string {
    const since = new Date(sinceTs * 1000);
    return `${since.toLocaleDateString('zh-CN')} ~ ${until.toLocaleDateString('zh-CN')}`;
  }

  private truncate(str: string, maxLen: number): string {
    if (!str) return '';
    if (str.length <= maxLen) return str;
    return `${str.substring(0, maxLen - 3)}...`;
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      logger.debug(`[WechatReportService] Created directory: ${dir}`);
    }
  }
}
