// Fetch history by time range task executor - retrieves conversation history within a time window

import { inject, injectable } from 'tsyringe';
import type {
  ConversationHistoryService,
  ConversationMessageEntry,
} from '@/conversation/history/ConversationHistoryService';
import { DITokens } from '@/core/DITokens';
import { DATE_TIMEZONE, dateInTimezone, formatDateTimeShort } from '@/utils/dateTime';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';
import { resolveConversationScope } from './conversationScope';

/** Hard ceiling on how many messages one window may load from the DB */
const MAX_FETCH_LIMIT = 2000;
/** Messages rendered per call when the caller does not ask for a different page size */
// Modest by design: this tool is now reachable from the reply turn, where every
// returned message lands directly in the model's context. Callers that genuinely
// want a whole day raise `limit` (up to MAX_LIMIT) or page with `offset`.
const DEFAULT_LIMIT = 80;
/** Upper bound the caller may raise `limit` to */
const MAX_LIMIT = 1000;
/** Per-message content cut-off in the rendered list */
const MAX_CONTENT_CHARS = 200;
/**
 * Backstop on the rendered transcript so one call can never blow up the caller's
 * context: `limit` is the caller's lever, this is the ceiling it cannot cross.
 */
const MAX_TRANSCRIPT_CHARS = 20_000;

/**
 * Parse a time string in the canonical data timezone (DATE_TIMEZONE).
 * Supports formats:
 * - "HH:mm" or "HH:mm:ss" (today)
 * - "YYYY-MM-DD HH:mm" or "YYYY-MM-DD HH:mm:ss"
 * - Relative: "-Xh" (X hours ago), "-Xm" (X minutes ago)
 */
function parseTimeInput(input: string): Date | null {
  const trimmed = input.trim();

  // Relative time: -2h, -30m
  const relativeMatch = trimmed.match(/^-(\d+)(h|m)$/i);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    const now = new Date();
    if (unit === 'h') {
      now.setTime(now.getTime() - value * 60 * 60 * 1000);
    } else {
      now.setTime(now.getTime() - value * 60 * 1000);
    }
    return now;
  }

  // Full datetime: YYYY-MM-DD HH:mm or YYYY-MM-DD HH:mm:ss
  const fullMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (fullMatch) {
    const [, year, month, day, hour, minute, second] = fullMatch;
    return dateInTimezone(`${year}-${month}-${day}`, `${hour.padStart(2, '0')}:${minute}:${second ?? '00'}`);
  }

  // Time only: HH:mm or HH:mm:ss (today in DATE_TIMEZONE)
  const timeOnlyMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (timeOnlyMatch) {
    const [, hour, minute, second] = timeOnlyMatch;
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: DATE_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const todayStr = formatter.format(new Date()); // YYYY-MM-DD
    return dateInTimezone(todayStr, `${hour.padStart(2, '0')}:${minute}:${second ?? '00'}`);
  }

  return null;
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'number' || Number.isNaN(raw)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(raw), min), max);
}

@Tool({
  name: 'fetch_history_by_time',
  description:
    '获取当前群指定时间段内的聊天记录。一次调用即返回该时间窗口内的全部消息（按时间正序），条数由 limit 控制（默认 200，最多 1000），超出部分用 offset 翻页——不需要把一个时间段拆成多次小窗口调用。',
  executor: 'fetch_history_by_time',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord', 'avatar-cmd'] }, subagent: true },
  parameters: {
    startTime: {
      type: 'string',
      required: true,
      description:
        '起始时间。支持格式："HH:mm"（今天）、"YYYY-MM-DD HH:mm"、相对时间 "-Xh"/"-Xm"（如 "-8h" 表示8小时前）',
    },
    endTime: {
      type: 'string',
      required: false,
      description: '结束时间（格式同 startTime）。省略则默认为当前时刻。',
    },
    includeBot: {
      type: 'boolean',
      required: false,
      description: '是否包含 bot 自身的消息。默认 false（仅用户消息）。',
    },
    limit: {
      type: 'number',
      required: false,
      description: `本次返回的消息条数上限，默认 ${DEFAULT_LIMIT}，最多 ${MAX_LIMIT}。要一次看完整天记录就把它调大。`,
    },
    offset: {
      type: 'number',
      required: false,
      description: '从窗口内第几条开始返回（0 起）。配合 limit 翻页，返回结果会写明下一页的 offset。',
    },
  },
  examples: [
    '获取今天凌晨1点到9点的聊天记录',
    '查看过去2小时的发言',
    '统计今天早上发言的人',
    '获取 2024-01-15 08:00 到 2024-01-15 12:00 的消息',
  ],
  triggerKeywords: ['历史记录', '聊天记录', '消息记录', '时间范围', '时间段'],
  whenToUse:
    '当范围由**时间**界定、而且你要的是那段时间里的完整对话时调用。常见场景：总结某段时间的讨论、统计发言人、回顾错过的对话。只要某个词或某个人的零散几条，用 search_chat_history——它只给命中的消息，这里给整段。',
})
@injectable()
export class FetchHistoryByTimeToolExecutor extends BaseToolExecutor {
  name = 'fetch_history_by_time';

  constructor(
    @inject(DITokens.CONVERSATION_HISTORY_SERVICE) private conversationHistoryService: ConversationHistoryService,
  ) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const scope = resolveConversationScope(context);
    if (!scope) {
      return this.error('当前没有可读取的会话', 'fetch_history_by_time requires a conversation context');
    }
    const groupId = scope.groupId;

    const startTimeStr = call.parameters?.startTime;
    if (typeof startTimeStr !== 'string' || !startTimeStr.trim()) {
      return this.error('请提供开始时间 (startTime)', 'Missing required parameter: startTime');
    }

    const startTime = parseTimeInput(startTimeStr);
    if (!startTime) {
      return this.error(
        `无法解析开始时间: ${startTimeStr}。支持格式: "HH:mm", "YYYY-MM-DD HH:mm", "-Xh", "-Xm"`,
        `Invalid startTime format: ${startTimeStr}`,
      );
    }

    let endTime: Date;
    const endTimeStr = call.parameters?.endTime;
    if (typeof endTimeStr === 'string' && endTimeStr.trim()) {
      const parsed = parseTimeInput(endTimeStr);
      if (!parsed) {
        return this.error(
          `无法解析结束时间: ${endTimeStr}。支持格式: "HH:mm", "YYYY-MM-DD HH:mm", "-Xh", "-Xm"`,
          `Invalid endTime format: ${endTimeStr}`,
        );
      }
      endTime = parsed;
    } else {
      endTime = new Date();
    }

    if (startTime >= endTime) {
      return this.error('开始时间必须早于结束时间', 'startTime must be before endTime');
    }

    const includeBot = call.parameters?.includeBot === true;
    const limit = clampInt(call.parameters?.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(call.parameters?.offset, 0, 0, MAX_FETCH_LIMIT);

    const windowMessages = await this.conversationHistoryService.getMessagesInRange(
      scope.sessionId,
      scope.sessionType,
      startTime,
      endTime,
      { includeBot, maxLimit: MAX_FETCH_LIMIT },
    );

    if (windowMessages.length === 0) {
      return this.success(`在 ${formatDateTimeShort(startTime)} 至 ${formatDateTimeShort(endTime)} 期间没有找到消息`, {
        groupId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        messageCount: 0,
        messages: [],
        uniqueUsers: [],
      });
    }

    const uniqueUsers = this.collectUsers(windowMessages);
    const page = windowMessages.slice(offset, offset + limit);
    if (page.length === 0) {
      return this.error(
        `offset=${offset} 超出范围：该时间窗口共 ${windowMessages.length} 条消息`,
        `offset ${offset} out of range (${windowMessages.length} messages)`,
      );
    }

    const { lines, shown } = this.renderTranscript(page);
    const shownFrom = offset + 1;
    const shownTo = offset + shown;
    const remaining = windowMessages.length - shownTo;

    const userSummary = uniqueUsers
      .map((u) => `${u.nickname ?? u.userId} (${u.userId}): ${u.messageCount}条消息`)
      .join('\n');

    const rangeLabel =
      shown === windowMessages.length
        ? `全部${windowMessages.length}条`
        : `第${shownFrom}-${shownTo}条 / 共${windowMessages.length}条`;

    const reply = [
      `时间范围: ${formatDateTimeShort(startTime)} 至 ${formatDateTimeShort(endTime)}`,
      `消息总数: ${windowMessages.length}条`,
      `发言用户: ${uniqueUsers.length}人`,
      '',
      '=== 发言统计 ===',
      userSummary,
      '',
      `=== 消息记录 (${rangeLabel}) ===`,
      lines,
    ];

    if (remaining > 0) {
      reply.push('', `还有 ${remaining} 条未返回。用同样的时间范围再调用一次本工具并传 offset=${shownTo} 即可续读。`);
    }
    if (windowMessages.length === MAX_FETCH_LIMIT) {
      reply.push(`（该时间窗口的消息数已达单次查询上限 ${MAX_FETCH_LIMIT} 条，更早的部分请缩小时间范围分段获取。）`);
    }

    return this.success(reply.join('\n'), {
      groupId,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      messageCount: windowMessages.length,
      returnedCount: shown,
      offset,
      nextOffset: remaining > 0 ? shownTo : undefined,
      uniqueUserCount: uniqueUsers.length,
      uniqueUsers,
      messages: page.slice(0, shown).map((m) => ({
        userId: m.userId,
        nickname: m.nickname,
        content: m.content,
        createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
        isBotReply: m.isBotReply,
      })),
    });
  }

  private collectUsers(
    messages: ConversationMessageEntry[],
  ): Array<{ userId: number | string; nickname?: string; messageCount: number }> {
    const userMap = new Map<number | string, { userId: number | string; nickname?: string; messageCount: number }>();
    for (const msg of messages) {
      if (msg.isBotReply) {
        continue;
      }
      const existing = userMap.get(msg.userId);
      if (existing) {
        existing.messageCount++;
        if (!existing.nickname && msg.nickname) {
          existing.nickname = msg.nickname;
        }
      } else {
        userMap.set(msg.userId, { userId: msg.userId, nickname: msg.nickname, messageCount: 1 });
      }
    }
    return Array.from(userMap.values()).sort((a, b) => b.messageCount - a.messageCount);
  }

  /** Render messages until the transcript budget is spent; returns how many actually made it in. */
  private renderTranscript(messages: ConversationMessageEntry[]): { lines: string; shown: number } {
    const rendered: string[] = [];
    let chars = 0;
    for (const msg of messages) {
      const time = formatDateTimeShort(msg.createdAt);
      const speaker = msg.isBotReply ? 'Bot' : (msg.nickname ?? String(msg.userId));
      const content =
        msg.content.length > MAX_CONTENT_CHARS ? `${msg.content.slice(0, MAX_CONTENT_CHARS)}...` : msg.content;
      const line = `[${time}] ${speaker}: ${content}`;
      if (chars + line.length > MAX_TRANSCRIPT_CHARS && rendered.length > 0) {
        break;
      }
      rendered.push(line);
      chars += line.length + 1;
    }
    return { lines: rendered.join('\n'), shown: rendered.length };
  }
}
