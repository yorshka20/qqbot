// runGroupReport — the one implementation of "analyse yesterday's chat and post the report card".
//
// Both entry points land here: the /group_report command (this plugin) and the scheduled
// `action group_report` (GroupReportActionHandler). They differ only in who triggers the run
// and what happens afterwards, so everything between "read yesterday" and "the image is sent"
// lives in this module and nowhere else.
//
// Statistics (hourly activity, totals, per-user counts) are pre-computed in code and injected
// into the prompt; the LLM only does semantic analysis. Up to BATCH_SIZE user messages go
// through the subagent in a single pass (it calls render_group_report itself); beyond that the
// messages are split into batches analysed by direct LLM calls, merged, then rendered directly.

import { getRolePreset } from '@/agent/SubAgentRolePresets';
import type { AIService } from '@/ai/AIService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { TOKEN_BUDGET } from '@/ai/tokenBudget';
import {
  type ConversationHistoryService,
  type ConversationMessageEntry,
  normalizeGroupId,
} from '@/conversation/history/ConversationHistoryService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { ToolManager } from '@/tools/ToolManager';
import { DATE_TIMEZONE, DISPLAY_TIMEZONE, dateInTimezone } from '@/utils/dateTime';
import { logger } from '@/utils/logger';
import {
  computeGroupReportStats,
  formatMessagesForContext,
  type GroupReportStats,
  splitIntoBatches,
} from './computeStats';
import type { GroupReportToolExecutor } from './GroupReportToolExecutor';
import {
  asObject,
  asString,
  normalizeFeaturedMessages,
  normalizeMemberComments,
  normalizeTopics,
} from './normalizeReport';
import type { FeaturedMessage, GroupReportData, MemberHighlight, ReportTopic } from './types';

/** Max messages to fetch from DB for report analysis (high to ensure full-day stats accuracy) */
const MAX_FETCH_LIMIT = 2000;

/** Max messages per LLM analysis batch */
const BATCH_SIZE = 500;

const TAG = '[GroupReport]';

export interface GroupReportRunRequest {
  groupId: string;
  groupName: string;
  /** Identity the single-pass subagent runs under */
  userId: number | string;
  protocol?: string;
}

export interface GroupReportRunResult {
  /** Yesterday's date (YYYY-MM-DD) in DATE_TIMEZONE */
  date: string;
  /** Yesterday's user messages — what the analysis was built from, for steps derived off the same read */
  userMessages: ConversationMessageEntry[];
  /** The report that was rendered; absent when there was nothing to report or every analysis attempt failed */
  report?: GroupReportData;
}

/** Services the run needs; resolved once so the private steps don't each hit the container. */
interface RunnerDeps {
  aiService: AIService;
  llmService: LLMService;
  promptManager: PromptManager;
  reportToolExecutor: GroupReportToolExecutor;
}

/** Partial analysis result returned by each batch LLM call */
interface BatchAnalysisResult {
  topics: ReportTopic[];
  memberHighlights: Array<{ userId: string; nickname: string; comment: string }>;
  featuredMessages: FeaturedMessage[];
  batchSummary: string;
}

export async function runGroupReport(request: GroupReportRunRequest): Promise<GroupReportRunResult> {
  const container = getContainer();
  const toolManager = container.resolve<ToolManager>(DITokens.TOOL_MANAGER);
  const reportToolExecutor = toolManager.getExecutor('render_group_report') as GroupReportToolExecutor | null;
  if (!reportToolExecutor) {
    throw new Error('render_group_report executor not registered');
  }

  const deps: RunnerDeps = {
    aiService: container.resolve<AIService>(DITokens.AI_SERVICE),
    llmService: container.resolve<LLMService>(DITokens.LLM_SERVICE),
    promptManager: container.resolve<PromptManager>(DITokens.PROMPT_MANAGER),
    reportToolExecutor,
  };
  const conversationHistoryService = container.resolve<ConversationHistoryService>(
    DITokens.CONVERSATION_HISTORY_SERVICE,
  );

  logger.info(`${TAG} Starting report generation for group ${request.groupId}`);

  const { start, end, dateStr } = getYesterdayRange();
  const { sessionId } = normalizeGroupId(request.groupId);
  const yesterdayMessages = await conversationHistoryService.getMessagesInRange(sessionId, 'group', start, end, {
    includeBot: true,
    maxLimit: MAX_FETCH_LIMIT,
  });

  const stats = computeGroupReportStats(yesterdayMessages);
  const userMessages = yesterdayMessages.filter((m) => !m.isBotReply);

  if (userMessages.length === 0) {
    logger.info(`${TAG} No user messages yesterday for group ${request.groupId}, skipping`);
    return { date: dateStr, userMessages };
  }

  const report =
    userMessages.length <= BATCH_SIZE
      ? await runSinglePass(deps, request, yesterdayMessages, stats, dateStr)
      : await runBatchedAnalysis(deps, request, userMessages, stats, dateStr);

  logger.info(`${TAG} Report generation completed for group ${request.groupId}`);
  return { date: dateStr, userMessages, report };
}

/**
 * Single-pass flow: messages fit in one LLM call, so the subagent assembles the report
 * and calls render_group_report itself; the rendered data is picked back up from the executor.
 */
async function runSinglePass(
  deps: RunnerDeps,
  request: GroupReportRunRequest,
  yesterdayMessages: ConversationMessageEntry[],
  stats: GroupReportStats,
  dateStr: string,
): Promise<GroupReportData | undefined> {
  const memberStatsText = stats.userStats
    .map((u) => `- ${u.nickname}(${u.userId}): ${u.messageCount}条消息`)
    .join('\n');

  const preset = getRolePreset('group_report');
  const description = deps.promptManager.render('subagent.group_report.task', {
    message: '生成昨日群聊每日汇报',
    groupName: request.groupName,
    date: dateStr,
    totalMessages: String(stats.totalMessages),
    activeMembers: String(stats.activeMembers),
    highlightTimeRange: stats.highlightTimeRange,
    hourlyActivityJson: JSON.stringify(stats.hourlyActivity),
    memberStats: memberStatsText,
    chatHistory: formatMessagesForContext(yesterdayMessages),
  });

  // Store pre-computed stats so the tool executor uses them (bypasses LLM data corruption)
  deps.reportToolExecutor.setPrecomputedStats(request.groupId, {
    totalMessages: stats.totalMessages,
    activeMembers: stats.activeMembers,
    highlightTimeRange: stats.highlightTimeRange,
    hourlyActivity: stats.hourlyActivity,
  });

  const parentContext = {
    userId: request.userId,
    groupId: request.groupId,
    messageType: 'group' as const,
    protocol: request.protocol,
  };

  const configOverrides = {
    ...preset.configOverrides,
    allowedTools: preset.defaultAllowedTools,
  };

  await deps.aiService.runSubAgent(preset.type, { description, input: {}, parentContext }, configOverrides);

  return deps.reportToolExecutor.takeRenderedReport(request.groupId);
}

/**
 * Batched flow: split messages into batches, analyze each via LLM, merge, then render directly.
 */
async function runBatchedAnalysis(
  deps: RunnerDeps,
  request: GroupReportRunRequest,
  userMessages: ConversationMessageEntry[],
  stats: GroupReportStats,
  dateStr: string,
): Promise<GroupReportData | undefined> {
  const batches = splitIntoBatches(userMessages, BATCH_SIZE);
  logger.info(`${TAG} Batched analysis: ${userMessages.length} messages → ${batches.length} batch(es)`);

  const providerName = resolveReportProvider();
  const batchResults: BatchAnalysisResult[] = [];

  // Sequential: batches are large prompts, running them in parallel invites rate limits.
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const timeRange = `${formatTime(batch[0].createdAt)} ~ ${formatTime(batch[batch.length - 1].createdAt)}`;
    const prompt = deps.promptManager.render('subagent.group_report.batch_task', {
      groupName: request.groupName,
      date: dateStr,
      chatHistory: formatMessagesForContext(batch),
      batchIndex: String(i + 1),
      totalBatches: String(batches.length),
      timeRange,
    });

    logger.info(`${TAG} Analyzing batch ${i + 1}/${batches.length} (${batch.length} msgs, ${timeRange})`);

    const MAX_ATTEMPTS = 3;
    let parsed: BatchAnalysisResult | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await deps.llmService.generate(
          prompt,
          {
            temperature: 0.7,
            maxTokens: TOKEN_BUDGET.document,
            jsonMode: true,
            // group_report batch JSON 生成是大 prompt + reasoning + jsonMode，
            // provider 默认 60-120s 超时不够（实测会触发 abort）。显式抬到 4 分钟。
            timeout: 240_000,
          },
          providerName,
        );
        parsed = parseBatchResult(response.text);
        if (parsed) {
          break;
        }
        logger.warn(`${TAG} Batch ${i + 1} attempt ${attempt}/${MAX_ATTEMPTS}: parse failed, retrying`);
      } catch (err) {
        logger.error(`${TAG} Batch ${i + 1} attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err);
      }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
    }
    if (parsed) {
      batchResults.push(parsed);
    } else {
      logger.error(`${TAG} Batch ${i + 1} exhausted all ${MAX_ATTEMPTS} attempts`);
    }
  }

  if (batchResults.length === 0) {
    logger.error(`${TAG} All batch analyses failed, aborting`);
    return undefined;
  }

  const reportData = mergeBatchResults(batchResults, stats, request.groupName, request.groupId, dateStr);
  await deps.reportToolExecutor.renderAndSend(reportData, request.groupId);
  return reportData;
}

/**
 * Provider the group_report preset runs on; an array preset picks one at random per run.
 * Exported so report-derived steps stay on the same provider as the report itself.
 */
export function resolveReportProvider(): string | undefined {
  const configProvider = getRolePreset('group_report').configOverrides.providerName;
  return Array.isArray(configProvider)
    ? configProvider[Math.floor(Math.random() * configProvider.length)]
    : configProvider;
}

/**
 * Parse a batch LLM response into structured result.
 *
 * This is the trust boundary between untrusted LLM JSON and typed internal
 * data: every array element is normalized so required string fields are
 * always present. The model intermittently omits fields (e.g. a member
 * highlight without `comment`); without per-element coercion an `undefined`
 * reaches the renderer's escapeHtml and throws.
 */
function parseBatchResult(text: string): BatchAnalysisResult | null {
  try {
    // Try to extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return null;
    }
    const data = asObject(JSON.parse(jsonMatch[0]));
    return {
      topics: normalizeTopics(data.topics),
      memberHighlights: normalizeMemberComments(data.memberHighlights),
      featuredMessages: normalizeFeaturedMessages(data.featuredMessages),
      batchSummary: asString(data.batchSummary),
    };
  } catch (err) {
    logger.warn(`${TAG} Failed to parse batch result:`, err);
    return null;
  }
}

/** Merge multiple batch analysis results with pre-computed stats into final report data. */
function mergeBatchResults(
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

  const totalSummary = batchResults
    .map((b) => b.batchSummary)
    .filter(Boolean)
    .join(' ');

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

/** Format a message timestamp as HH:MM. */
function formatTime(createdAt: Date | string): string {
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
function getYesterdayRange(): { start: Date; end: Date; dateStr: string } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: DATE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // Get today's date components in the target timezone
  const parts = formatter.formatToParts(new Date());
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
  return {
    start: dateInTimezone(dateStr, '00:00:00'),
    end: dateInTimezone(dateStr, '23:59:59.999'),
    dateStr,
  };
}
