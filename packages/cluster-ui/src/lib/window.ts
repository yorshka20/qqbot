import type { Run } from './runs';
import { isLive } from './stage';
import { toMs } from './time';

export type RunWindow = '24h' | '7d' | 'all';

export const RUN_WINDOW_LABEL: Record<RunWindow, string> = {
  '24h': '最近 24 小时',
  '7d': '最近 7 天',
  all: '全部',
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export function windowStart(window: RunWindow, now: number): number {
  switch (window) {
    case '24h':
      return now - DAY;
    case '7d':
      return now - 7 * DAY;
    case 'all':
      return 0;
  }
}

/** A live run is always in the window; a finished one is dated by when it completed, else when it started. */
export function inWindow(run: Run, window: RunWindow, now: number): boolean {
  if (isLive(run.task)) {
    return true;
  }
  const at = toMs(run.task.completedAt) ?? toMs(run.task.createdAt) ?? 0;
  return at >= windowStart(window, now);
}

/** Whether the loaded history stops short of the window's start while the daemon still has older runs. */
export function needsOlderHistory(
  oldestLoadedAt: number | null,
  window: RunWindow,
  now: number,
  hasMore: boolean,
): boolean {
  return hasMore && (oldestLoadedAt === null || oldestLoadedAt > windowStart(window, now));
}
