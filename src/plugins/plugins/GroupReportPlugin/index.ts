// GroupReportPlugin - generates group daily reports via subagent
//
// Statistics (hourly activity, totals, per-user counts) are pre-computed in code
// and injected into the prompt. The LLM subagent only handles semantic analysis
// (topics, member comments, featured messages, summary).
//
// Registers:
//   - /group_report command (triggers the subagent)
//   - render_group_report tool (subagent calls this to render + send the image)

import { getRolePreset } from '@/agent/SubAgentRolePresets';
import type { AIService } from '@/ai/AIService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { CommandManager } from '@/command/CommandManager';
import type { CommandContext, CommandResult } from '@/command/types';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { ToolManager } from '@/tools/ToolManager';
import type { ToolSpec } from '@/tools/types';
import { DATE_TIMEZONE } from '@/utils/dateTime';
import { logger } from '@/utils/logger';
import { RegisterPlugin } from '../../decorators';
import { PluginBase } from '../../PluginBase';
import { PluginCommandHandler } from '../../PluginCommandHandler';
import { computeGroupReportStats, formatMessagesForContext } from './computeStats';
import { GroupReportToolExecutor } from './GroupReportToolExecutor';

/** Max messages to fetch from DB for report analysis */
const MAX_FETCH_LIMIT = 500;

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
  whenToUse: '当需要生成并发送群聊每日汇报图片时调用。统计数据已由系统预计算，你只需填入语义分析结果并调用此工具。',
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
  private conversationHistoryService!: ConversationHistoryService;

  async onInit(): Promise<void> {
    const container = getContainer();

    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);
    this.aiService = container.resolve<AIService>(DITokens.AI_SERVICE);
    this.promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    this.conversationHistoryService = container.resolve<ConversationHistoryService>(
      DITokens.CONVERSATION_HISTORY_SERVICE,
    );

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

    const groupId = context.groupId;
    const groupName = context.originalMessage?.groupName || `群${groupId}`;

    // Fire-and-forget: pre-compute stats then run subagent
    void (async () => {
      try {
        logger.info(`[GroupReportPlugin] Starting report generation for group ${groupId}`);

        // 1. Fetch today's messages from DB
        const todayStart = this.getTodayStart();
        const allMessages = await this.conversationHistoryService.getRecentMessages(groupId, MAX_FETCH_LIMIT);
        const todayMessages = allMessages.filter((msg) => {
          const msgTime = msg.createdAt instanceof Date ? msg.createdAt.getTime() : new Date(msg.createdAt).getTime();
          return msgTime >= todayStart.getTime();
        });

        // 2. Compute statistics
        const stats = computeGroupReportStats(todayMessages);
        const chatHistory = formatMessagesForContext(todayMessages);

        // 3. Format today's date
        const dateFormatter = new Intl.DateTimeFormat('en-CA', {
          timeZone: DATE_TIMEZONE,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        });
        const todayDate = dateFormatter.format(new Date());

        // 4. Format per-user stats for template
        const memberStatsText = stats.userStats
          .map((u) => `- ${u.nickname}(${u.userId}): ${u.messageCount}条消息`)
          .join('\n');

        // 5. Format hourly activity JSON for template
        const hourlyActivityJson = JSON.stringify(stats.hourlyActivity);

        // 6. Render task template with pre-computed data
        const preset = getRolePreset('group_report');
        const taskTemplate = this.promptManager.getTemplate('subagent.group_report.task');
        const description = taskTemplate
          ? this.promptManager.render('subagent.group_report.task', {
              message: '生成今日群聊每日汇报',
              groupName,
              date: todayDate,
              totalMessages: String(stats.totalMessages),
              activeMembers: String(stats.activeMembers),
              highlightTimeRange: stats.highlightTimeRange,
              hourlyActivityJson,
              memberStats: memberStatsText,
              chatHistory,
            })
          : '生成今日群聊每日汇报';

        const parentContext = {
          userId: context.userId,
          groupId,
          messageType: 'group' as const,
          protocol: context.metadata?.protocol as string | undefined,
        };

        const configOverrides = {
          ...preset.configOverrides,
          allowedTools: preset.defaultAllowedTools,
        };

        await this.aiService.runSubAgent(preset.type, { description, input: {}, parentContext }, configOverrides);
        logger.info(`[GroupReportPlugin] Report generation completed for group ${groupId}`);
      } catch (err) {
        logger.error(`[GroupReportPlugin] Report generation failed:`, err);
      }
    })();

    const mb = new MessageBuilder();
    mb.text('⏳ 正在生成今日群聊汇报，请稍候...');
    return { success: true, segments: mb.build() };
  }

  /**
   * Get the start of today (00:00) in the configured timezone.
   */
  private getTodayStart(): Date {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: DATE_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const todayStr = formatter.format(new Date()); // YYYY-MM-DD
    return new Date(`${todayStr}T00:00:00`);
  }
}
