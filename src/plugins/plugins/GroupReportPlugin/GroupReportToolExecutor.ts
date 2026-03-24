// render_group_report tool executor - renders group daily report as image and sends it

import type { Page } from 'puppeteer-core';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { MessageBuilder } from '@/message/MessageBuilder';
import { BrowserService } from '@/services/browser/BrowserService';
import type { ToolCall, ToolExecutionContext, ToolExecutor, ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';
import { renderReportHTML } from './renderReportHTML';
import type { GroupReportData } from './types';

export class GroupReportToolExecutor implements ToolExecutor {
  name = 'render_group_report';

  constructor(private messageAPI: MessageAPI) {}

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const groupId = context.groupId;
    if (!groupId) {
      return this.error('只有群聊场景下才能生成群报告', 'render_group_report requires group context');
    }

    const reportDataStr = call.parameters?.reportData;
    if (typeof reportDataStr !== 'string' || !reportDataStr.trim()) {
      return this.error('请提供报告数据 (reportData)', 'Missing required parameter: reportData');
    }

    let reportData: GroupReportData;
    try {
      reportData = JSON.parse(reportDataStr) as GroupReportData;
    } catch {
      return this.error('报告数据JSON格式错误', 'Invalid JSON in reportData');
    }

    if (!reportData.groupName || !reportData.date || reportData.totalMessages === undefined) {
      return this.error(
        '报告数据缺少必填字段 (groupName, date, totalMessages)',
        'Missing required fields in reportData',
      );
    }

    // Fill defaults
    reportData.groupId = String(groupId);
    reportData.hourlyActivity = reportData.hourlyActivity ?? [];
    reportData.topics = reportData.topics ?? [];
    reportData.memberHighlights = reportData.memberHighlights ?? [];
    reportData.featuredMessages = reportData.featuredMessages ?? [];
    reportData.totalSummary = reportData.totalSummary ?? '';
    reportData.highlightTimeRange = reportData.highlightTimeRange ?? '';
    reportData.activeMembers = reportData.activeMembers ?? 0;

    try {
      logger.info(`[GroupReportTool] Rendering report for group ${groupId}`);
      const imageBuffer = await this.renderToImage(reportData);
      const base64 = imageBuffer.toString('base64');

      const mb = new MessageBuilder();
      mb.image({ data: base64 });
      const segments = mb.build();

      await this.messageAPI.sendGroupMessage(Number(groupId), segments, 'milky');
      logger.info(`[GroupReportTool] Report image sent to group ${groupId}`);

      return this.success('群聊每日汇报图片已成功发送到群内。');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[GroupReportTool] Failed to render/send report:`, err);
      return this.error(`渲染或发送报告失败: ${errMsg}`, errMsg);
    }
  }

  private async renderToImage(data: GroupReportData): Promise<Buffer> {
    const html = renderReportHTML(data);
    let page: Page | null = null;

    try {
      page = await BrowserService.getInstance().createPage();

      await page.setViewport({
        width: 1000,
        height: 3000,
        deviceScaleFactor: 2,
      });

      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });

      // Wait for avatar images to load
      await page.evaluate(() => {
        const images = Array.from(document.querySelectorAll('img'));
        return Promise.allSettled(
          images.map(
            (img) =>
              new Promise<void>((resolve) => {
                if (img.complete) return resolve();
                img.onload = () => resolve();
                img.onerror = () => resolve();
                setTimeout(resolve, 5000);
              }),
          ),
        );
      });

      await page.evaluate(() => document.fonts.ready);
      await new Promise((r) => setTimeout(r, 500));

      const bounds = await page.evaluate(() => {
        const container = document.querySelector('.report-container');
        if (!container) return null;
        const rect = container.getBoundingClientRect();
        return {
          x: Math.max(0, Math.round(rect.x)),
          y: Math.max(0, Math.round(rect.y)),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });

      if (!bounds) {
        throw new Error('Failed to calculate report content bounds');
      }

      logger.debug(`[GroupReportTool] Content bounds: ${bounds.width}x${bounds.height}`);

      const screenshot = await page.screenshot({
        type: 'jpeg',
        quality: 85,
        clip: bounds,
        omitBackground: false,
      });

      return screenshot as Buffer;
    } finally {
      if (page) {
        await page.close().catch((e) => {
          logger.warn('[GroupReportTool] Failed to close page:', e);
        });
      }
    }
  }

  private success(reply: string): ToolResult {
    return { success: true, reply };
  }

  private error(reply: string, error: string): ToolResult {
    return { success: false, reply, error };
  }
}
