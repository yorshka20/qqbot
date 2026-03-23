// render_group_report tool executor - renders group daily report as image and sends it

import { inject, injectable } from 'tsyringe';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { GroupReportRenderer } from '@/services/groupReport/GroupReportRenderer';
import type { GroupReportData } from '@/services/groupReport/types';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

@Tool({
  name: 'render_group_report',
  description:
    '渲染群聊每日汇报为精美图片并发送到群内。需要传入完整的报告数据（JSON格式），包括统计数据、话题分析、成员点评、精选发言和总评。',
  executor: 'render_group_report',
  visibility: ['subagent'],
  parameters: {
    reportData: {
      type: 'string',
      required: true,
      description:
        '报告数据JSON字符串。结构: { groupName, groupId, date, totalMessages, activeMembers, highlightTimeRange, hourlyActivity: [{hour, count}], topics: [{title, summary}], memberHighlights: [{userId, nickname, messageCount, comment}], featuredMessages: [{userId, nickname, content, comment}], totalSummary }',
    },
  },
  examples: ['生成群聊每日汇报', '渲染今日群报告'],
  triggerKeywords: ['每日汇报', '群报告', '日报'],
  whenToUse:
    '当需要生成并发送群聊每日汇报图片时调用。必须先通过 fetch_history_by_time 获取聊天记录，分析后组装报告数据。',
})
@injectable()
export class GroupReportToolExecutor extends BaseToolExecutor {
  name = 'render_group_report';

  constructor(@inject(DITokens.MESSAGE_API) private messageAPI: MessageAPI) {
    super();
  }

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

    // Validate required fields
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
      const imageBuffer = await GroupReportRenderer.getInstance().render(reportData);
      const base64 = imageBuffer.toString('base64');

      // Send image to group
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
}
