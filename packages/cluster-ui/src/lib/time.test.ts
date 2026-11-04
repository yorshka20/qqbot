import { describe, expect, test } from 'bun:test';
import { formatAgo, formatClock, formatDayLabel, formatSpan, formatWait } from './time';

const MIN = 60_000;

describe('formatSpan', () => {
  test('reads at the coarsest useful grain', () => {
    expect(formatSpan(7 * MIN)).toBe('7 分钟');
    expect(formatSpan(125 * MIN)).toBe('2 小时 5 分');
    expect(formatSpan(120 * MIN)).toBe('2 小时');
    expect(formatSpan(3 * 24 * 60 * MIN)).toBe('3 天');
  });

  test('wait and ago say 刚刚 under a minute', () => {
    expect(formatWait(30_000)).toBe('刚刚');
    expect(formatWait(7 * MIN)).toBe('等了 7 分钟');
    expect(formatAgo(30_000)).toBe('刚刚');
    expect(formatAgo(7 * MIN)).toBe('7 分钟前');
  });
});

describe('formatClock', () => {
  test('adds the date only for another day', () => {
    const at = new Date(2026, 10, 4, 15, 2).getTime();
    expect(formatClock(at, new Date(2026, 10, 4, 23, 0).getTime())).toBe('15:02');
    expect(formatClock(at, new Date(2026, 10, 5, 1, 0).getTime())).toBe('11-04 15:02');
  });
});

describe('formatDayLabel', () => {
  const now = new Date(2026, 10, 4, 12, 0).getTime();

  test('today', () => {
    expect(formatDayLabel(new Date(2026, 10, 4, 9, 0).getTime(), now)).toBe('今天');
  });

  test('yesterday', () => {
    expect(formatDayLabel(new Date(2026, 10, 3, 23, 0).getTime(), now)).toBe('昨天');
  });

  test('anything earlier is a bare date', () => {
    expect(formatDayLabel(new Date(2026, 10, 1, 9, 0).getTime(), now)).toBe('11-01');
  });
});
