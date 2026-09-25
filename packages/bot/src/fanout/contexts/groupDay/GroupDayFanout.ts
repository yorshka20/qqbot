// GroupDayFanout — yesterday's chat in one group, as the shared context for its tasks.
//
// The prefix is the group name, the date, code-computed statistics and the full day's
// log. Every task (report, comic, memory extraction, …) reads that same text, so it is
// rendered once per run and its bytes must not vary by task: changing context.txt,
// the line format or the truncation changes every task's cache key at once.

import { inject, injectable } from 'tsyringe';
import {
  type ConversationHistoryService,
  type ConversationMessageEntry,
  normalizeGroupId,
} from '@/conversation/history/ConversationHistoryService';
import { DITokens } from '@/core/DITokens';
import { DATE_TIMEZONE, dateInTimezone } from '@/utils/dateTime';
import { BaseFanout, type FanoutContext, type FanoutModel } from '../../core/BaseFanout';
import { FanoutServices } from '../../core/FanoutServices';
import type { FanoutTarget } from '../../core/types';
import { computeGroupDayStats, formatChatLog, type GroupDayStats } from './stats';

/** Upper bound on messages read for one day; the day's single context is built from these. */
export const MAX_FETCH_LIMIT = 2000;

const CONTEXT_TEMPLATE = 'fanout.group_day.context';

export interface GroupDayContext {
  groupId: string;
  groupName: string;
  /** YYYY-MM-DD in DATE_TIMEZONE */
  date: string;
  stats: GroupDayStats;
  /** The day's messages without the bot's own replies */
  userMessages: ConversationMessageEntry[];
}

@injectable()
export class GroupDayFanout extends BaseFanout<GroupDayContext> {
  static readonly NAME = 'group_day';
  readonly name = GroupDayFanout.NAME;
  protected readonly systemTemplate = 'fanout.group_day.system';

  constructor(
    @inject(FanoutServices) services: FanoutServices,
    @inject(DITokens.CONVERSATION_HISTORY_SERVICE) private readonly historyService: ConversationHistoryService,
  ) {
    super(services);
  }

  protected resolveModel(): FanoutModel {
    const ai = this.services.config.getAIConfig();
    const provider = ai?.taskProviders?.groupDay ?? ai?.defaultProviders?.llm;
    if (!provider) {
      throw new Error('group_day: no provider (ai.taskProviders.groupDay or ai.defaultProviders.llm)');
    }
    return { provider, model: ai?.taskProviders?.groupDayModel };
  }

  protected async buildContext(target: FanoutTarget): Promise<FanoutContext<GroupDayContext> | null> {
    const { start, end, date } = getYesterdayRange();
    const { sessionId } = normalizeGroupId(target.id);
    const messages = await this.historyService.getMessagesInRange(sessionId, 'group', start, end, {
      includeBot: true,
      maxLimit: MAX_FETCH_LIMIT,
    });
    const userMessages = messages.filter((m) => !m.isBotReply);
    if (userMessages.length === 0) {
      return null;
    }

    const stats = computeGroupDayStats(messages);
    const prefix = this.services.promptManager
      .render(CONTEXT_TEMPLATE, {
        groupName: target.name,
        date,
        totalMessages: String(stats.totalMessages),
        activeMembers: String(stats.activeMembers),
        highlightTimeRange: stats.highlightTimeRange,
        hourlyActivityJson: JSON.stringify(stats.hourlyActivity),
        memberStats: stats.userStats.map((u) => `- ${u.nickname}(${u.userId}): ${u.messageCount}条消息`).join('\n'),
        chatHistory: formatChatLog(messages),
      })
      .trimEnd();

    return {
      ctx: { groupId: target.id, groupName: target.name, date, stats, userMessages },
      prefix,
    };
  }
}

/**
 * Yesterday's calendar day in DATE_TIMEZONE, 00:00:00 to 23:59:59.999, independent of
 * when the run fires, so a late or repeated run still covers exactly that day.
 */
export function getYesterdayRange(): { start: Date; end: Date; date: string } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: DATE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const today = new Date(parseInt(get('year'), 10), parseInt(get('month'), 10) - 1, parseInt(get('day'), 10));
  today.setDate(today.getDate() - 1);
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return {
    start: dateInTimezone(date, '00:00:00'),
    end: dateInTimezone(date, '23:59:59.999'),
    date,
  };
}
