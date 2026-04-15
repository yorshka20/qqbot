// GroupReportPlugin - generates group daily reports via subagent
//
// Statistics (hourly activity, totals, per-user counts) are pre-computed in code
// and injected into the prompt. The LLM subagent only handles semantic analysis
// (topics, member comments, featured messages, summary).
//
// When chat history exceeds BATCH_SIZE, messages are split into batches and
// analyzed independently via LLM calls, then merged before rendering.
//
// Registers:
//   - /group_report command (triggers the subagent)
//   - render_group_report tool (subagent calls this to render + send the image)

import { getRolePreset } from '@/agent/SubAgentRolePresets';
import type { AIService } from '@/ai/AIService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { CommandManager } from '@/command/CommandManager';
import type { CommandContext, CommandResult } from '@/command/types';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { ToolManager } from '@/tools/ToolManager';
import type { ToolSpec } from '@/tools/types';
import { DATE_TIMEZONE, DISPLAY_TIMEZONE, dateInTimezone } from '@/utils/dateTime';
import { logger } from '@/utils/logger';
import { RegisterPlugin } from '../../decorators';
import { PluginBase } from '../../PluginBase';
import { PluginCommandHandler } from '../../PluginCommandHandler';
import {
  computeGroupReportStats,
  formatMessagesForContext,
  type GroupReportStats,
  splitIntoBatches,
} from './computeStats';
import { GroupReportToolExecutor } from './GroupReportToolExecutor';
import type { FeaturedMessage, GroupReportData, MemberHighlight, ReportTopic } from './types';

/** Max messages to fetch from DB for report analysis (high to ensure full-day stats accuracy) */
const MAX_FETCH_LIMIT = 2000;

/** Max messages per LLM analysis batch */
const BATCH_SIZE = 500;

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
  whenToUse: '当需要生成并发送群聊每日汇报图片时调用。统计数据已由系统预计算，你只需填入语义分析结果并调用此工具。',
};

/** Partial analysis result returned by each batch LLM call */
interface BatchAnalysisResult {
  topics: ReportTopic[];
  memberHighlights: Array<{ userId: string; nickname: string; comment: string }>;
  featuredMessages: FeaturedMessage[];
  batchSummary: string;
}

@RegisterPlugin({
  name: 'groupReport',
  version: '1.0.0',
  description: 'Generates group daily report via subagent analysis of chat history, rendered as an image card',
})
export class GroupReportPlugin extends PluginBase {
  private commandManager!: CommandManager;
  private aiService!: AIService;
  private llmService!: LLMService;
  private promptManager!: PromptManager;
  private conversationHistoryService!: ConversationHistoryService;
  private messageAPI!: MessageAPI;
  private reportToolExecutor!: GroupReportToolExecutor;

  async onInit(): Promise<void> {
    const container = getContainer();

    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);
    this.aiService = container.resolve<AIService>(DITokens.AI_SERVICE);
    this.llmService = container.resolve<LLMService>(DITokens.LLM_SERVICE);
    this.promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    this.conversationHistoryService = container.resolve<ConversationHistoryService>(
      DITokens.CONVERSATION_HISTORY_SERVICE,
    );
    this.messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);

    // Register tool
    const toolManager = container.resolve<ToolManager>(DITokens.TOOL_MANAGER);

    toolManager.registerTool(TOOL_SPEC);
    this.reportToolExecutor = new GroupReportToolExecutor(this.messageAPI);
    toolManager.registerExecutor(this.reportToolExecutor);

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

    // Fire-and-forget: pre-compute stats then run analysis
    void (async () => {
      try {
        logger.info(`[GroupReportPlugin] Starting report generation for group ${groupId}`);

        // 1. Compute yesterday's fixed time range (00:00:00 ~ 23:59:59) in configured timezone
        const { start, end, dateStr } = this.getYesterdayRange();

        // 2. Fetch messages since yesterday start, then filter by end boundary
        const allSince = await this.conversationHistoryService.getMessagesSince(groupId, start, MAX_FETCH_LIMIT);
        const endTime = end.getTime();
        const yesterdayMessages = allSince.filter((msg) => {
          const msgTime = msg.createdAt instanceof Date ? msg.createdAt.getTime() : new Date(msg.createdAt).getTime();
          return msgTime <= endTime;
        });

        // 3. Compute statistics from ALL messages
        const stats = computeGroupReportStats(yesterdayMessages);

        // 4. Filter out bot messages for analysis
        const userMessages = yesterdayMessages.filter((m) => !m.isBotReply);

        if (userMessages.length === 0) {
          logger.info(`[GroupReportPlugin] No user messages yesterday for group ${groupId}, skipping`);
          return;
        }

        // 5. Choose single-pass or batched flow based on message count
        if (userMessages.length <= BATCH_SIZE) {
          await this.runSinglePass(groupId, groupName, yesterdayMessages, stats, dateStr, context);
        } else {
          await this.runBatchedAnalysis(groupId, groupName, userMessages, stats, dateStr);
        }

        logger.info(`[GroupReportPlugin] Report generation completed for group ${groupId}`);
      } catch (err) {
        logger.error(`[GroupReportPlugin] Report generation failed:`, err);
      }
    })();

    const mb = new MessageBuilder();
    mb.text('⏳ 正在生成昨日群聊汇报，请稍候...');
    return { success: true, segments: mb.build() };
  }

  /**
   * Single-pass flow: messages fit in one LLM call, use existing subagent with render tool.
   */
  private async runSinglePass(
    groupId: string | number,
    groupName: string,
    yesterdayMessages: Parameters<typeof formatMessagesForContext>[0],
    stats: GroupReportStats,
    dateStr: string,
    context: CommandContext,
  ): Promise<void> {
    const chatHistory = formatMessagesForContext(yesterdayMessages);

    const memberStatsText = stats.userStats
      .map((u) => `- ${u.nickname}(${u.userId}): ${u.messageCount}条消息`)
      .join('\n');
    const hourlyActivityJson = JSON.stringify(stats.hourlyActivity);

    const preset = getRolePreset('group_report');
    const taskTemplate = this.promptManager.getTemplate('subagent.group_report.task');
    const description = taskTemplate
      ? this.promptManager.render('subagent.group_report.task', {
          message: '生成昨日群聊每日汇报',
          groupName,
          date: dateStr,
          totalMessages: String(stats.totalMessages),
          activeMembers: String(stats.activeMembers),
          highlightTimeRange: stats.highlightTimeRange,
          hourlyActivityJson,
          memberStats: memberStatsText,
          chatHistory,
        })
      : '生成昨日群聊每日汇报';

    // Store pre-computed stats so the tool executor uses them (bypasses LLM data corruption)
    this.reportToolExecutor.setPrecomputedStats(String(groupId), {
      totalMessages: stats.totalMessages,
      activeMembers: stats.activeMembers,
      highlightTimeRange: stats.highlightTimeRange,
      hourlyActivity: stats.hourlyActivity,
    });

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
  }

  /**
   * Batched flow: split messages into batches, analyze each via LLM, merge, then render directly.
   */
  private async runBatchedAnalysis(
    groupId: string | number,
    groupName: string,
    userMessages: Parameters<typeof formatMessagesForContext>[0],
    stats: GroupReportStats,
    dateStr: string,
  ): Promise<void> {
    const batches = splitIntoBatches(userMessages, BATCH_SIZE);
    logger.info(`[GroupReportPlugin] Batched analysis: ${userMessages.length} messages → ${batches.length} batch(es)`);

    // Analyze each batch (sequentially to avoid rate limit pressure)
    const batchResults: BatchAnalysisResult[] = [];
    const preset = getRolePreset('group_report');
    const configProvider = preset.configOverrides.providerName;
    const providerName = Array.isArray(configProvider)
      ? configProvider[Math.floor(Math.random() * configProvider.length)]
      : configProvider;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const chatHistory = formatMessagesForContext(batch);

      // Determine time range of this batch
      const firstMsg = batch[0];
      const lastMsg = batch[batch.length - 1];
      const timeRange = `${this.formatTime(firstMsg.createdAt)} ~ ${this.formatTime(lastMsg.createdAt)}`;

      const prompt = this.buildBatchPrompt(groupName, dateStr, chatHistory, i + 1, batches.length, timeRange);

      logger.info(
        `[GroupReportPlugin] Analyzing batch ${i + 1}/${batches.length} (${batch.length} msgs, ${timeRange})`,
      );

      const MAX_ATTEMPTS = 3;
      let parsed: BatchAnalysisResult | null = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const response = await this.llmService.generate(
            prompt,
            { temperature: 0.7, maxTokens: 4000, jsonMode: true },
            providerName,
          );
          parsed = this.parseBatchResult(response.text);
          if (parsed) break;
          logger.warn(
            `[GroupReportPlugin] Batch ${i + 1} attempt ${attempt}/${MAX_ATTEMPTS}: parse failed, retrying`,
          );
        } catch (err) {
          logger.error(
            `[GroupReportPlugin] Batch ${i + 1} attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
            err,
          );
        }
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        }
      }
      if (parsed) {
        batchResults.push(parsed);
      } else {
        logger.error(`[GroupReportPlugin] Batch ${i + 1} exhausted all ${MAX_ATTEMPTS} attempts`);
      }
    }

    if (batchResults.length === 0) {
      logger.error('[GroupReportPlugin] All batch analyses failed, aborting');
      return;
    }

    // Merge batch results + pre-computed stats → final report data
    const reportData = this.mergeBatchResults(batchResults, stats, groupName, String(groupId), dateStr);

    // Render and send directly (bypass subagent since analysis is already done)
    await this.reportToolExecutor.renderAndSend(reportData, String(groupId));
  }

  /**
   * Build the prompt for a single batch analysis.
   */
  private buildBatchPrompt(
    groupName: string,
    date: string,
    chatHistory: string,
    batchIndex: number,
    totalBatches: number,
    timeRange: string,
  ): string {
    const templateName = 'subagent.group_report.batch_task';
    const hasTemplate = !!this.promptManager.getTemplate(templateName);

    if (hasTemplate) {
      return this.promptManager.render(templateName, {
        groupName,
        date,
        chatHistory,
        batchIndex: String(batchIndex),
        totalBatches: String(totalBatches),
        timeRange,
      });
    }

    // Fallback if template is missing
    return [
      `请分析以下群聊记录片段（第${batchIndex}批/共${totalBatches}批，时段${timeRange}），提取话题、成员点评、精选发言和小结。`,
      `群名称: ${groupName}，日期: ${date}`,
      '',
      chatHistory,
      '',
      '请严格输出JSON: {"topics":[{"title":"...","summary":"..."}],"memberHighlights":[{"userId":"...","nickname":"...","comment":"..."}],"featuredMessages":[{"userId":"...","nickname":"...","content":"...","comment":"..."}],"batchSummary":"..."}',
    ].join('\n');
  }

  /**
   * Parse a batch LLM response into structured result.
   */
  private parseBatchResult(text: string): BatchAnalysisResult | null {
    try {
      // Try to extract JSON from response (may be wrapped in markdown code block)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const data = JSON.parse(jsonMatch[0]) as BatchAnalysisResult;
      return {
        topics: Array.isArray(data.topics) ? data.topics : [],
        memberHighlights: Array.isArray(data.memberHighlights) ? data.memberHighlights : [],
        featuredMessages: Array.isArray(data.featuredMessages) ? data.featuredMessages : [],
        batchSummary: typeof data.batchSummary === 'string' ? data.batchSummary : '',
      };
    } catch (err) {
      logger.warn('[GroupReportPlugin] Failed to parse batch result:', err);
      return null;
    }
  }

  /**
   * Merge multiple batch analysis results with pre-computed stats into final report data.
   */
  private mergeBatchResults(
    batchResults: BatchAnalysisResult[],
    stats: GroupReportStats,
    groupName: string,
    groupId: string,
    date: string,
  ): GroupReportData {
    // Merge topics: collect all, deduplicate by title similarity, cap at 5
    const allTopics: ReportTopic[] = [];
    const seenTitles = new Set<string>();
    for (const batch of batchResults) {
      for (const topic of batch.topics) {
        const key = topic.title.slice(0, 10);
        if (!seenTitles.has(key)) {
          seenTitles.add(key);
          allTopics.push(topic);
        }
      }
    }

    // Merge member highlights: keep first (best) comment per userId, attach real stats
    const memberMap = new Map<string, { nickname: string; comment: string }>();
    for (const batch of batchResults) {
      for (const mh of batch.memberHighlights) {
        if (!memberMap.has(mh.userId)) {
          memberMap.set(mh.userId, { nickname: mh.nickname, comment: mh.comment });
        }
      }
    }
    // Build final member highlights using pre-computed stats for accurate counts
    const statsMap = new Map(stats.userStats.map((u) => [u.userId, u]));
    const memberHighlights: MemberHighlight[] = [];
    for (const [userId, data] of memberMap) {
      const userStat = statsMap.get(userId);
      memberHighlights.push({
        userId,
        nickname: userStat?.nickname ?? data.nickname,
        messageCount: userStat?.messageCount ?? 0,
        comment: data.comment,
      });
    }
    // Sort by message count descending, cap at 6
    memberHighlights.sort((a, b) => b.messageCount - a.messageCount);

    // Merge featured messages: collect all, cap at 5
    const allFeatured: FeaturedMessage[] = [];
    for (const batch of batchResults) {
      allFeatured.push(...batch.featuredMessages);
    }

    // Merge summaries into one totalSummary
    const summaries = batchResults.map((b) => b.batchSummary).filter(Boolean);
    const totalSummary = summaries.join(' ');

    return {
      groupName,
      groupId,
      date,
      totalMessages: stats.totalMessages,
      activeMembers: stats.activeMembers,
      highlightTimeRange: stats.highlightTimeRange,
      hourlyActivity: stats.hourlyActivity,
      topics: allTopics.slice(0, 5),
      memberHighlights: memberHighlights.slice(0, 6),
      featuredMessages: allFeatured.slice(0, 5),
      totalSummary,
    };
  }

  /**
   * Format a message timestamp as HH:MM.
   */
  private formatTime(createdAt: Date | string): string {
    const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: DISPLAY_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
    return `${h}:${m}`;
  }

  /**
   * Get yesterday's fixed time range in the configured timezone.
   * Returns start (00:00:00), end (23:59:59), and formatted date string (YYYY-MM-DD).
   * Decoupled from execution time so the report always covers the full previous day.
   */
  private getYesterdayRange(): { start: Date; end: Date; dateStr: string } {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: DATE_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // Get today's date components in the target timezone
    const now = new Date();
    const parts = formatter.formatToParts(now);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
    const todayYear = parseInt(get('year'), 10);
    const todayMonth = parseInt(get('month'), 10);
    const todayDay = parseInt(get('day'), 10);

    // Subtract one calendar day (handles month/year boundaries correctly)
    const todayLocal = new Date(todayYear, todayMonth - 1, todayDay);
    todayLocal.setDate(todayLocal.getDate() - 1);
    const y = todayLocal.getFullYear();
    const m = String(todayLocal.getMonth() + 1).padStart(2, '0');
    const d = String(todayLocal.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;

    // Construct start/end with correct timezone offset (not machine-local time)
    const start = dateInTimezone(dateStr, '00:00:00');
    const end = dateInTimezone(dateStr, '23:59:59.999');
    return { start, end, dateStr };
  }
}
