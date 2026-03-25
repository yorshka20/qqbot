// Pre-compute group report statistics from chat history.
// Handles all mechanical data aggregation so the LLM only does semantic analysis.

import type { ConversationMessageEntry } from '@/conversation/history/ConversationHistoryService';
import { DATE_TIMEZONE } from '@/utils/dateTime';
import type { HourlyActivity } from './types';

export interface UserStats {
  userId: string;
  nickname: string;
  messageCount: number;
}

export interface GroupReportStats {
  totalMessages: number;
  activeMembers: number;
  hourlyActivity: HourlyActivity[];
  highlightTimeRange: string;
  userStats: UserStats[];
}

/**
 * Get the hour (0-23) of a date in Asia/Tokyo timezone.
 */
function getHourInTimezone(date: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: DATE_TIMEZONE,
    hour: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0';
  // Intl may return "24" for midnight in some locales; normalize to 0
  const hour = parseInt(hourStr, 10);
  return hour === 24 ? 0 : hour;
}

/**
 * Compute all mechanical statistics from chat messages.
 * Returns hourly activity, totals, highlight time range, and per-user stats.
 */
export function computeGroupReportStats(messages: ConversationMessageEntry[]): GroupReportStats {
  // Filter out bot replies
  const userMessages = messages.filter((m) => !m.isBotReply);

  // Hourly activity: count messages per hour (0-23)
  const hourlyCounts = new Array<number>(24).fill(0);
  for (const msg of userMessages) {
    const date = msg.createdAt instanceof Date ? msg.createdAt : new Date(msg.createdAt);
    const hour = getHourInTimezone(date);
    hourlyCounts[hour]++;
  }

  const hourlyActivity: HourlyActivity[] = hourlyCounts.map((count, hour) => ({ hour, count }));

  // Find highlight time range: most active 2-hour consecutive window
  let maxSum = 0;
  let maxStartHour = 0;
  for (let i = 0; i < 24; i++) {
    const sum = hourlyCounts[i] + hourlyCounts[(i + 1) % 24];
    if (sum > maxSum) {
      maxSum = sum;
      maxStartHour = i;
    }
  }
  const endHour = (maxStartHour + 2) % 24;
  const highlightTimeRange =
    maxSum > 0 ? `${String(maxStartHour).padStart(2, '0')}:00-${String(endHour).padStart(2, '0')}:00` : '无活跃时段';

  // Per-user stats
  const userMap = new Map<string, UserStats>();
  for (const msg of userMessages) {
    const id = String(msg.userId);
    const existing = userMap.get(id);
    if (existing) {
      existing.messageCount++;
      if (!existing.nickname && msg.nickname) {
        existing.nickname = msg.nickname;
      }
    } else {
      userMap.set(id, {
        userId: id,
        nickname: msg.nickname ?? id,
        messageCount: 1,
      });
    }
  }

  const userStats = Array.from(userMap.values()).sort((a, b) => b.messageCount - a.messageCount);

  return {
    totalMessages: userMessages.length,
    activeMembers: userStats.length,
    hourlyActivity,
    highlightTimeRange,
    userStats,
  };
}

/**
 * Format message history as text for LLM context.
 * Includes all messages with timestamps and speaker names.
 */
export function formatMessagesForContext(messages: ConversationMessageEntry[]): string {
  const userMessages = messages.filter((m) => !m.isBotReply);

  if (userMessages.length === 0) return '（今日暂无聊天记录）';

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: DATE_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return userMessages
    .map((msg) => {
      const date = msg.createdAt instanceof Date ? msg.createdAt : new Date(msg.createdAt);
      const parts = formatter.formatToParts(date);
      const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
      const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
      const time = `${h}:${m}`;
      const speaker = msg.nickname ?? String(msg.userId);
      const userId = String(msg.userId);
      const content = msg.content.length > 200 ? `${msg.content.slice(0, 200)}...` : msg.content;
      return `[${time}] ${speaker}(${userId}): ${content}`;
    })
    .join('\n');
}
