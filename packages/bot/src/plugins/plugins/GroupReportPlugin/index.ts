// GroupReportPlugin - owns the group daily report feature.
//
// Registers:
//   - /group_report command (runs the report for the current group)
//   - render_group_report tool (the subagent calls this to render + send the image)
//   - group_report agenda action handler (scheduled runs; enable-scoped, see onEnable)
//
// The generation flow itself lives in runReport.ts, shared by the command and the
// scheduled handler.

import type { AgendaService } from '@/agenda/AgendaService';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { CommandManager } from '@/command/CommandManager';
import type { CommandContext, CommandResult } from '@/command/types';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { ToolManager } from '@/tools/ToolManager';
import type { ToolSpec } from '@/tools/types';
import { logger } from '@/utils/logger';
import { RegisterPlugin } from '../../decorators';
import { PluginBase } from '../../PluginBase';
import { PluginCommandHandler } from '../../PluginCommandHandler';
import { GroupReportActionHandler } from './GroupReportActionHandler';
import { GroupReportToolExecutor } from './GroupReportToolExecutor';
import { runGroupReport } from './runReport';

const TOOL_SPEC: ToolSpec = {
  name: 'render_group_report',
  description:
    '渲染群聊每日汇报为精美图片并发送到群内。需要传入完整的报告数据（JSON格式），包括统计数据、话题分析、成员点评、精选发言和总评。',
  executor: 'render_group_report',
  visibility: { subagent: true },
  parameters: {
    reportData: {
      type: 'string',
      required: true,
      description:
        '报告数据JSON字符串。结构: { groupName, groupId, date, totalMessages, activeMembers, highlightTimeRange, hourlyActivity: [{hour, count}], topics: [{title, summary}], memberHighlights: [{userId, nickname, messageCount, comment}], featuredMessages: [{userId, nickname, content, comment}], totalSummary }',
    },
  },
  examples: ['生成群聊每日汇报', '渲染今日群报告'],
  whenToUse: '当需要生成并发送群聊每日汇报图片时调用。统计数据已由系统预计算，你只需填入语义分析结果并调用此工具。',
};

@RegisterPlugin({
  name: 'groupReport',
  version: '1.0.0',
  description: 'Generates group daily report via subagent analysis of chat history, rendered as an image card',
})
export class GroupReportPlugin extends PluginBase {
  async onInit(): Promise<void> {
    const container = getContainer();
    const toolManager = container.resolve<ToolManager>(DITokens.TOOL_MANAGER);
    const messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);

    toolManager.registerTool(TOOL_SPEC);
    toolManager.registerExecutor(new GroupReportToolExecutor(messageAPI));

    const cmdHandler = new PluginCommandHandler(
      'group_report',
      '生成群聊每日汇报',
      '/group_report',
      (args, ctx) => this.handleCommand(args, ctx),
      this.context,
      ['admin', 'owner'],
    );
    container.resolve<CommandManager>(DITokens.COMMAND_MANAGER).register(cmdHandler, this.name);

    logger.info('[GroupReportPlugin] Initialized (command + tool registered)');
  }

  async onEnable(): Promise<void> {
    await super.onEnable();
    this.agendaService().registerActionHandler(new GroupReportActionHandler());
    logger.info('[GroupReportPlugin] Registered agenda action handler: group_report');
  }

  async onDisable(): Promise<void> {
    await super.onDisable();
    this.agendaService().unregisterActionHandler('group_report');
    logger.info('[GroupReportPlugin] Unregistered agenda action handler: group_report');
  }

  private agendaService(): AgendaService {
    return getContainer().resolve<AgendaService>(DITokens.AGENDA_SERVICE);
  }

  private async handleCommand(_args: string[], context: CommandContext): Promise<CommandResult> {
    if (!context.groupId) {
      return { success: false, error: '此命令仅在群聊中可用' };
    }

    const groupId = String(context.groupId);
    const groupName = context.originalMessage?.groupName || `群${groupId}`;

    // Fire-and-forget: the report takes minutes and delivers itself as an image
    void runGroupReport({
      groupId,
      groupName,
      userId: context.userId,
      protocol: context.metadata?.protocol as string | undefined,
    }).catch((err) => {
      logger.error('[GroupReportPlugin] Report generation failed:', err);
    });

    const mb = new MessageBuilder();
    mb.text('⏳ 正在生成昨日群聊汇报，请稍候...');
    return { success: true, segments: mb.build() };
  }
}
