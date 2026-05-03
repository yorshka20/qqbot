// GroupReportHandler - action handler for scheduled group daily report generation.
// Reuses the same pre-computation + subagent flow as GroupReportPlugin's /group_report command,
// ensuring template variables (stats, chat history) are properly injected.

import { getRolePreset } from '@/agent/SubAgentRolePresets';
import type { AIService } from '@/ai/AIService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import {
  computeGroupReportStats,
  formatMessagesForContext,
  type GroupReportStats,
  splitIntoBatches,
} from '@/plugins/plugins/GroupReportPlugin/computeStats';
import type { GroupReportToolExecutor } from '@/plugins/plugins/GroupReportPlugin/GroupReportToolExecutor';
import type {
  FeaturedMessage,
  GroupReportData,
  MemberHighlight,
  ReportTopic,
} from '@/plugins/plugins/GroupReportPlugin/types';
import type { ToolManager } from '@/tools/ToolManager';
import { DATE_TIMEZONE, DISPLAY_TIMEZONE, dateInTimezone } from '@/utils/dateTime';
import { logger } from '@/utils/logger';
import type { ActionHandler, ActionHandlerContext } from '../ActionHandlerRegistry';

const MAX_FETCH_LIMIT = 2000;
const BATCH_SIZE = 500;

interface BatchAnalysisResult {
  topics: ReportTopic[];
  memberHighlights: Array<{ userId: string; nickname: string; comment: string }>;
  featuredMessages: FeaturedMessage[];
  batchSummary: string;
}

export class GroupReportHandler implements ActionHandler {
  readonly name = 'group_report';

  async execute(ctx: ActionHandlerContext): Promise<string | undefined> {
    const groupId = ctx.groupId;
    if (!groupId) {
      logger.error('[GroupReportHandler] No groupId in context');
      return;
    }

    const container = getContainer();
    const conversationHistoryService = container.resolve<ConversationHistoryService>(
      DITokens.CONVERSATION_HISTORY_SERVICE,
    );
    const aiService = container.resolve<AIService>(DITokens.AI_SERVICE);
    const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    const toolManager = container.resolve<ToolManager>(DITokens.TOOL_MANAGER);

    const reportToolExecutor = toolManager.getExecutor('render_group_report') as GroupReportToolExecutor | null;
    if (!reportToolExecutor) {
      logger.error('[GroupReportHandler] render_group_report executor not found');
      return '❌ 群日报生成失败: render_group_report 工具未注册';
    }

    const groupName = `群${groupId}`;

    try {
      logger.info(`[GroupReportHandler] Starting report generation for group ${groupId}`);

      const { start, end, dateStr } = this.getYesterdayRange();

      const allSince = await conversationHistoryService.getMessagesSince(groupId, start, MAX_FETCH_LIMIT);
      const endTime = end.getTime();
      const yesterdayMessages = allSince.filter((msg) => {
        const msgTime = msg.createdAt instanceof Date ? msg.createdAt.getTime() : new Date(msg.createdAt).getTime();
        return msgTime <= endTime;
      });

      const stats = computeGroupReportStats(yesterdayMessages);
      const userMessages = yesterdayMessages.filter((m) => !m.isBotReply);

      if (userMessages.length === 0) {
        logger.info(`[GroupReportHandler] No user messages yesterday for group ${groupId}, skipping`);
        return;
      }

      if (userMessages.length <= BATCH_SIZE) {
        await this.runSinglePass(
          groupId,
          groupName,
          yesterdayMessages,
          stats,
          dateStr,
          aiService,
          promptManager,
          reportToolExecutor,
          ctx,
        );
      } else {
        await this.runBatchedAnalysis(
          groupId,
          groupName,
          userMessages,
          stats,
          dateStr,
          promptManager,
          reportToolExecutor,
        );
      }

      logger.info(`[GroupReportHandler] Report generation completed for group ${groupId}`);
      // Return void — render_group_report tool already sent the image to the group
    } catch (err) {
      logger.error('[GroupReportHandler] Report generation failed:', err);
      return '❌ 群日报生成失败';
    }
  }

  private async runSinglePass(
    groupId: string,
    groupName: string,
    yesterdayMessages: Parameters<typeof formatMessagesForContext>[0],
    stats: GroupReportStats,
    dateStr: string,
    aiService: AIService,
    promptManager: PromptManager,
    reportToolExecutor: GroupReportToolExecutor,
    ctx: ActionHandlerContext,
  ): Promise<void> {
    const chatHistory = formatMessagesForContext(yesterdayMessages);
    const memberStatsText = stats.userStats
      .map((u) => `- ${u.nickname}(${u.userId}): ${u.messageCount}条消息`)
      .join('\n');
    const hourlyActivityJson = JSON.stringify(stats.hourlyActivity);

    const preset = getRolePreset('group_report');
    const taskTemplate = promptManager.getTemplate('subagent.group_report.task');
    const description = taskTemplate
      ? promptManager.render('subagent.group_report.task', {
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

    reportToolExecutor.setPrecomputedStats(String(groupId), {
      totalMessages: stats.totalMessages,
      activeMembers: stats.activeMembers,
      highlightTimeRange: stats.highlightTimeRange,
      hourlyActivity: stats.hourlyActivity,
    });

    const parentContext = {
      userId: ctx.userId ? Number(ctx.userId) : 0,
      groupId,
      messageType: 'group' as const,
      protocol: ctx.protocol as string | undefined,
    };

    const configOverrides = {
      ...preset.configOverrides,
      allowedTools: preset.defaultAllowedTools,
    };

    await aiService.runSubAgent(preset.type, { description, input: {}, parentContext }, configOverrides);
  }

  private async runBatchedAnalysis(
    groupId: string,
    groupName: string,
    userMessages: Parameters<typeof formatMessagesForContext>[0],
    stats: GroupReportStats,
    dateStr: string,
    promptManager: PromptManager,
    reportToolExecutor: GroupReportToolExecutor,
  ): Promise<void> {
    const batches = splitIntoBatches(userMessages, BATCH_SIZE);
    logger.info(`[GroupReportHandler] Batched analysis: ${userMessages.length} messages → ${batches.length} batch(es)`);

    const llmService = getContainer().resolve<LLMService>(DITokens.LLM_SERVICE);
    const preset = getRolePreset('group_report');
    const configProvider = preset.configOverrides.providerName;
    const providerName = Array.isArray(configProvider)
      ? configProvider[Math.floor(Math.random() * configProvider.length)]
      : configProvider;

    const batchResults: BatchAnalysisResult[] = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const chatHistory = formatMessagesForContext(batch);
      const firstMsg = batch[0];
      const lastMsg = batch[batch.length - 1];
      const timeRange = `${this.formatTime(firstMsg.createdAt)} ~ ${this.formatTime(lastMsg.createdAt)}`;

      const prompt = this.buildBatchPrompt(
        promptManager,
        groupName,
        dateStr,
        chatHistory,
        i + 1,
        batches.length,
        timeRange,
      );

      logger.info(
        `[GroupReportHandler] Analyzing batch ${i + 1}/${batches.length} (${batch.length} msgs, ${timeRange})`,
      );

      const MAX_ATTEMPTS = 3;
      let parsed: BatchAnalysisResult | null = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const response = await llmService.generate(
            prompt,
            {
              temperature: 0.7,
              maxTokens: 4000,
              jsonMode: true,
              // group_report batch JSON 生成是大 prompt + reasoning + jsonMode，
              // provider 默认 60-120s 超时不够（实测会触发 abort）。显式抬到 4 分钟。
              timeout: 240_000,
            },
            providerName,
          );
          parsed = this.parseBatchResult(response.text);
          if (parsed) break;
          logger.warn(`[GroupReportHandler] Batch ${i + 1} attempt ${attempt}/${MAX_ATTEMPTS}: parse failed, retrying`);
        } catch (err) {
          logger.error(`[GroupReportHandler] Batch ${i + 1} attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err);
        }
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        }
      }
      if (parsed) {
        batchResults.push(parsed);
      } else {
        logger.error(`[GroupReportHandler] Batch ${i + 1} exhausted all ${MAX_ATTEMPTS} attempts`);
      }
    }

    if (batchResults.length === 0) {
      logger.error('[GroupReportHandler] All batch analyses failed, aborting');
      return;
    }

    const reportData = this.mergeBatchResults(batchResults, stats, groupName, String(groupId), dateStr);
    await reportToolExecutor.renderAndSend(reportData, String(groupId));
  }

  private buildBatchPrompt(
    promptManager: PromptManager,
    groupName: string,
    date: string,
    chatHistory: string,
    batchIndex: number,
    totalBatches: number,
    timeRange: string,
  ): string {
    const templateName = 'subagent.group_report.batch_task';
    const hasTemplate = !!promptManager.getTemplate(templateName);

    if (hasTemplate) {
      return promptManager.render(templateName, {
        groupName,
        date,
        chatHistory,
        batchIndex: String(batchIndex),
        totalBatches: String(totalBatches),
        timeRange,
      });
    }

    return [
      `请分析以下群聊记录片段（第${batchIndex}批/共${totalBatches}批，时段${timeRange}），提取话题、成员点评、精选发言和小结。`,
      `群名称: ${groupName}，日期: ${date}`,
      '',
      chatHistory,
      '',
      '请严格输出JSON: {"topics":[{"title":"...","summary":"..."}],"memberHighlights":[{"userId":"...","nickname":"...","comment":"..."}],"featuredMessages":[{"userId":"...","nickname":"...","content":"...","comment":"..."}],"batchSummary":"..."}',
    ].join('\n');
  }

  private parseBatchResult(text: string): BatchAnalysisResult | null {
    try {
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
      logger.warn('[GroupReportHandler] Failed to parse batch result:', err);
      return null;
    }
  }

  private mergeBatchResults(
    batchResults: BatchAnalysisResult[],
    stats: GroupReportStats,
    groupName: string,
    groupId: string,
    date: string,
  ): GroupReportData {
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

    const memberMap = new Map<string, { nickname: string; comment: string }>();
    for (const batch of batchResults) {
      for (const mh of batch.memberHighlights) {
        if (!memberMap.has(mh.userId)) {
          memberMap.set(mh.userId, { nickname: mh.nickname, comment: mh.comment });
        }
      }
    }
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
    memberHighlights.sort((a, b) => b.messageCount - a.messageCount);

    const allFeatured: FeaturedMessage[] = [];
    for (const batch of batchResults) {
      allFeatured.push(...batch.featuredMessages);
    }

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

  private getYesterdayRange(): { start: Date; end: Date; dateStr: string } {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: DATE_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const now = new Date();
    const parts = formatter.formatToParts(now);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
    const todayYear = parseInt(get('year'), 10);
    const todayMonth = parseInt(get('month'), 10);
    const todayDay = parseInt(get('day'), 10);

    const todayLocal = new Date(todayYear, todayMonth - 1, todayDay);
    todayLocal.setDate(todayLocal.getDate() - 1);
    const y = todayLocal.getFullYear();
    const m = String(todayLocal.getMonth() + 1).padStart(2, '0');
    const d = String(todayLocal.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;

    const start = dateInTimezone(dateStr, '00:00:00');
    const end = dateInTimezone(dateStr, '23:59:59.999');
    return { start, end, dateStr };
  }

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
}
