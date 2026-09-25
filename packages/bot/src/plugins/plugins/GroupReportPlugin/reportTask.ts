// The daily report as a group_day task: semantic analysis from the model, numbers from code.
//
// The model writes topics, member comments, featured messages and a summary. Totals,
// hourly activity and per-member counts come from the day's stats, so no count the
// model might misread or rewrite ever reaches the card.

import type { PromptManager } from '@/ai/prompt/PromptManager';
import { TOKEN_BUDGET } from '@/ai/tokenBudget';
import { extractJsonFromLlmText } from '@/ai/utils/llmJsonExtract';
import type { GroupDayContext } from '@/fanout/contexts/groupDay/GroupDayFanout';
import type { FanoutRun, FanoutTask, FanoutTaskOutput } from '@/fanout/core/types';
import type { GroupReportRenderer } from './GroupReportRenderer';
import {
  asObject,
  asString,
  normalizeFeaturedMessages,
  normalizeMemberComments,
  normalizeTopics,
} from './normalizeReport';
import type { GroupReportData, MemberHighlight } from './types';

const TASK_TEMPLATE = 'group_report.report';
const MAX_TOPICS = 5;
const MAX_MEMBER_HIGHLIGHTS = 6;
const MAX_FEATURED_MESSAGES = 5;

export interface ReportTaskDeps {
  promptManager: PromptManager;
  renderer: GroupReportRenderer;
}

export class ReportTask implements FanoutTask<GroupDayContext, null> {
  static readonly NAME = 'report';
  readonly name = ReportTask.NAME;
  readonly tools = [];
  readonly limits = { maxTokens: TOKEN_BUDGET.document, timeout: 360_000, maxToolRounds: 1 };

  constructor(private readonly deps: ReportTaskDeps) {}

  parseParams(): null {
    return null;
  }

  suffix(): string {
    return this.deps.promptManager.render(TASK_TEMPLATE);
  }

  async handle(output: FanoutTaskOutput, run: FanoutRun<GroupDayContext>): Promise<void> {
    const json = extractJsonFromLlmText(output.text, { strategies: ['codeBlock', 'braceMatch'], expect: 'object' });
    if (!json) {
      throw new Error('report output carries no JSON object');
    }
    const report = assembleReport(asObject(JSON.parse(json)), run.ctx);
    await this.deps.renderer.renderAndSend(report, run.ctx.groupId, run.target.protocol);
  }
}

/**
 * Merge the model's semantic fields with the day's stats. A highlighted member must be
 * someone who spoke that day; any other id the model produced is dropped.
 */
export function assembleReport(data: Record<string, unknown>, ctx: GroupDayContext): GroupReportData {
  const statsByUser = new Map(ctx.stats.userStats.map((u) => [u.userId, u]));
  const memberHighlights: MemberHighlight[] = [];
  for (const m of normalizeMemberComments(data.memberHighlights)) {
    const stat = statsByUser.get(m.userId);
    if (!stat || memberHighlights.some((h) => h.userId === m.userId)) {
      continue;
    }
    memberHighlights.push({
      userId: m.userId,
      nickname: stat.nickname,
      messageCount: stat.messageCount,
      comment: m.comment,
    });
  }
  memberHighlights.sort((a, b) => b.messageCount - a.messageCount);

  return {
    groupName: ctx.groupName,
    groupId: ctx.groupId,
    date: ctx.date,
    totalMessages: ctx.stats.totalMessages,
    activeMembers: ctx.stats.activeMembers,
    highlightTimeRange: ctx.stats.highlightTimeRange,
    hourlyActivity: ctx.stats.hourlyActivity,
    topics: normalizeTopics(data.topics).slice(0, MAX_TOPICS),
    memberHighlights: memberHighlights.slice(0, MAX_MEMBER_HIGHLIGHTS),
    featuredMessages: normalizeFeaturedMessages(data.featuredMessages).slice(0, MAX_FEATURED_MESSAGES),
    totalSummary: asString(data.totalSummary),
  };
}
