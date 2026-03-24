// GroupReportPlugin - generates group daily reports via subagent
//
// Registers:
//   - /group_report command (triggers the subagent)
//   - render_group_report tool (subagent calls this to render + send the image)

import type { AIService } from '@/ai/AIService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { getRolePreset } from '@/agent/SubAgentRolePresets';
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
import { GroupReportToolExecutor } from './GroupReportToolExecutor';

const TOOL_SPEC: ToolSpec = {
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
};

@RegisterPlugin({
  name: 'groupReport',
  version: '1.0.0',
  description: 'Generates group daily report via subagent analysis of chat history, rendered as an image card',
})
export class GroupReportPlugin extends PluginBase {
  private commandManager!: CommandManager;
  private aiService!: AIService;
  private promptManager!: PromptManager;

  async onInit(): Promise<void> {
    const container = getContainer();

    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);
    this.aiService = container.resolve<AIService>(DITokens.AI_SERVICE);
    this.promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);

    // Register tool
    const toolManager = container.resolve<ToolManager>(DITokens.TOOL_MANAGER);
    const messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);

    toolManager.registerTool(TOOL_SPEC);
    toolManager.registerExecutor(new GroupReportToolExecutor(messageAPI));

    // Register command
    const cmdHandler = new PluginCommandHandler(
      'group_report',
      '生成群聊每日汇报',
      '/group_report',
      (args, ctx) => this.handleCommand(args, ctx),
      this.context,
      ['admin', 'owner'],
    );
    this.commandManager.register(cmdHandler, this.name);

    logger.info('[GroupReportPlugin] Initialized (command + tool registered)');
  }

  private async handleCommand(_args: string[], context: CommandContext): Promise<CommandResult> {
    if (!context.groupId) {
      return { success: false, error: '此命令仅在群聊中可用' };
    }

    const groupName = context.originalMessage?.groupName || `群${context.groupId}`;

    const preset = getRolePreset('group_report');
    const taskTemplate = this.promptManager.getTemplate('subagent.group_report.task');
    const description = taskTemplate
      ? this.promptManager.render('subagent.group_report.task', {
          message: '生成今日群聊每日汇报',
          groupName,
        })
      : '生成今日群聊每日汇报';

    const parentContext = {
      userId: context.userId,
      groupId: context.groupId,
      messageType: 'group' as const,
      protocol: context.metadata?.protocol as string | undefined,
    };

    const configOverrides = {
      ...preset.configOverrides,
      allowedTools: preset.defaultAllowedTools,
    };

    // Fire-and-forget: run subagent in background
    void (async () => {
      try {
        logger.info(`[GroupReportPlugin] Starting report generation for group ${context.groupId}`);
        await this.aiService.runSubAgent(
          preset.type,
          { description, input: { instruction: description }, parentContext },
          configOverrides,
        );
        logger.info(`[GroupReportPlugin] Report generation completed for group ${context.groupId}`);
      } catch (err) {
        logger.error(`[GroupReportPlugin] Report generation failed:`, err);
      }
    })();

    const mb = new MessageBuilder();
    mb.text('⏳ 正在生成今日群聊汇报，请稍候...');
    return { success: true, segments: mb.build() };
  }
}
