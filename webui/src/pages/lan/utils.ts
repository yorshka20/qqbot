import type { LanReportLevel } from '../../types';

/**
 * Human-readable elapsed-time formatter for LAN client lifetimes.
 *
 * Different from `webui/src/pages/cluster/utils.ts#formatMs` because the
 * cluster version rounds up to the next unit aggressively (it's used for
 * task durations where "10m 47s ≈ 11m" is fine), whereas LAN clients are
 * long-lived and we want to show two units of precision (`1h 23m`).
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Format a unix-ms timestamp via `toLocaleString`, with a String() fallback. */
export function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

/** Tailwind class set for an internal_report level badge. */
export function levelBadgeClass(level: LanReportLevel): string {
  switch (level) {
    case 'error':
      return 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300';
    case 'warn':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300';
    case 'info':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300';
    default:
      return 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  }
}
