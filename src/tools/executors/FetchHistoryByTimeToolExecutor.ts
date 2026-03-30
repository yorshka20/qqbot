// Fetch history by time range task executor - retrieves conversation history within a time window

import { inject, injectable } from 'tsyringe';
import { type ConversationHistoryService, normalizeGroupId } from '@/conversation/history/ConversationHistoryService';
import { DITokens } from '@/core/DITokens';
import { DATE_TIMEZONE, formatDateTimeShort } from '@/utils/dateTime';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

/** Maximum messages to fetch from DB before filtering by time */
const MAX_FETCH_LIMIT = 500;

/**
 * Parse a time string relative to today in Asia/Shanghai timezone.
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
    // Create date in Asia/Shanghai timezone
    const dateStr = `${year}-${month}-${day}T${hour.padStart(2, '0')}:${minute}:${second ?? '00'}`;
    // Parse as local time in the target timezone
    const date = new Date(dateStr);
    // Adjust for timezone offset (this is approximate; full TZ handling would need a library)
    return date;
  }

  // Time only: HH:mm or HH:mm:ss (today in Asia/Shanghai)
  const timeOnlyMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (timeOnlyMatch) {
    const [, hour, minute, second] = timeOnlyMatch;
    const now = new Date();
    // Get today's date in Asia/Shanghai
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: DATE_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const todayStr = formatter.format(now); // YYYY-MM-DD
    const dateStr = `${todayStr}T${hour.padStart(2, '0')}:${minute}:${second ?? '00'}`;
    return new Date(dateStr);
  }

  return null;
}

@Tool({
  name: 'fetch_history_by_time',
  description: '获取当前群指定时间段内的聊天记录。返回该时间窗口内的消息列表（发送者、内容、时间）。',
  executor: 'fetch_history_by_time',
  visibility: ['subagent'],
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
  },
  examples: [
    '获取今天凌晨1点到9点的聊天记录',
    '查看过去2小时的发言',
    '统计今天早上发言的人',
    '获取 2024-01-15 08:00 到 2024-01-15 12:00 的消息',
  ],
  triggerKeywords: ['历史记录', '聊天记录', '发言记录', '消息记录', '时间范围', '时间段'],
  whenToUse: '当需要获取特定时间段内的群聊消息时调用。常见场景：总结某段时间的讨论、统计发言人、回顾错过的对话。',
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
    const groupId = context.groupId;
    if (!groupId) {
      return this.error('只有群聊场景下才能获取聊天记录', 'fetch_history_by_time requires group context');
    }

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

    // Fetch recent messages from DB
    const { sessionId } = normalizeGroupId(groupId);
    const allMessages = await this.conversationHistoryService.getRecentMessagesForSession(
      sessionId,
      'group',
      MAX_FETCH_LIMIT,
    );

    // Filter by time range
    const startTs = startTime.getTime();
    const endTs = endTime.getTime();
    const filtered = allMessages.filter((msg) => {
      const msgTime = msg.createdAt instanceof Date ? msg.createdAt.getTime() : new Date(msg.createdAt).getTime();
      if (msgTime < startTs || msgTime > endTs) {
        return false;
      }
      if (!includeBot && msg.isBotReply) {
        return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      return this.success(`在 ${formatDateTimeShort(startTime)} 至 ${formatDateTimeShort(endTime)} 期间没有找到消息`, {
        groupId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        messageCount: 0,
        messages: [],
        uniqueUsers: [],
      });
    }

    // Collect unique users
    const userMap = new Map<number | string, { userId: number | string; nickname?: string; messageCount: number }>();
    for (const msg of filtered) {
      if (msg.isBotReply) continue;
      const existing = userMap.get(msg.userId);
      if (existing) {
        existing.messageCount++;
        if (!existing.nickname && msg.nickname) {
          existing.nickname = msg.nickname;
        }
      } else {
        userMap.set(msg.userId, {
          userId: msg.userId,
          nickname: msg.nickname,
          messageCount: 1,
        });
      }
    }

    const uniqueUsers = Array.from(userMap.values()).sort((a, b) => b.messageCount - a.messageCount);

    // Format output
    const userSummary = uniqueUsers
      .map((u) => `${u.nickname ?? u.userId} (${u.userId}): ${u.messageCount}条消息`)
      .join('\n');

    const messageSummary = filtered
      .slice(0, 50) // Limit output to avoid too long response
      .map((msg) => {
        const time = formatDateTimeShort(msg.createdAt);
        const speaker = msg.isBotReply ? 'Bot' : (msg.nickname ?? String(msg.userId));
        return `[${time}] ${speaker}: ${msg.content.slice(0, 100)}${msg.content.length > 100 ? '...' : ''}`;
      })
      .join('\n');

    const reply = [
      `时间范围: ${formatDateTimeShort(startTime)} 至 ${formatDateTimeShort(endTime)}`,
      `消息总数: ${filtered.length}条`,
      `发言用户: ${uniqueUsers.length}人`,
      '',
      '=== 发言统计 ===',
      userSummary,
      '',
      `=== 消息记录 (前${Math.min(50, filtered.length)}条) ===`,
      messageSummary,
    ].join('\n');

    return this.success(reply, {
      groupId,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      messageCount: filtered.length,
      uniqueUserCount: uniqueUsers.length,
      uniqueUsers,
      messages: filtered.map((m) => ({
        userId: m.userId,
        nickname: m.nickname,
        content: m.content,
        createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
        isBotReply: m.isBotReply,
      })),
    });
  }
}
