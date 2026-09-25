// Statistics and chat-log text for one group's day, computed in code so the model
// only does semantic work and never has to count.

import type { ConversationMessageEntry } from '@/conversation/history/ConversationHistoryService';
import { DISPLAY_TIMEZONE } from '@/utils/dateTime';

export interface HourlyActivity {
  hour: number;
  count: number;
}

export interface UserStats {
  userId: string;
  nickname: string;
  messageCount: number;
}

export interface GroupDayStats {
  totalMessages: number;
  activeMembers: number;
  hourlyActivity: HourlyActivity[];
  highlightTimeRange: string;
  userStats: UserStats[];
}

/**
 * Get the hour (0-23) of a date in display timezone (Asia/Shanghai).
 */
function getHourInTimezone(date: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: DISPLAY_TIMEZONE,
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
 * Hourly activity (always 24 entries, 0-23), totals, the busiest two-hour window and
 * per-user counts. Bot replies are excluded.
 */
export function computeGroupDayStats(messages: ConversationMessageEntry[]): GroupDayStats {
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
 * Chat log for the shared prefix, one line per user message: `[HH:MM] nickname(userId): content`.
 * Content over 200 characters is cut, so one pasted wall of text cannot dominate the day.
 */
export function formatChatLog(messages: ConversationMessageEntry[]): string {
  const userMessages = messages.filter((m) => !m.isBotReply);

  if (userMessages.length === 0) return '（昨日暂无聊天记录）';

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: DISPLAY_TIMEZONE,
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
