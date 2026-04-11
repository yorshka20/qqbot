import { Activity } from 'lucide-react';
import type { LanReportRow } from '../../../types';
import { formatTimestamp, levelBadgeClass } from '../utils';

/**
 * Tail of `internal_report` rows for the currently-selected client.
 *
 * Pure presentation. Renders four mutually-exclusive empty/loading/error
 * states explicitly so each path stays trivially auditable instead of
 * collapsing into one nested ternary.
 */
export function ReportsPanel({
  selectedClientId,
  reports,
  loading,
  error,
}: {
  selectedClientId: string | null;
  reports: LanReportRow[];
  loading: boolean;
  error: string | null;
}) {
  if (!selectedClientId) {
    return (
      <div className="text-sm text-zinc-500 dark:text-zinc-400 py-4 text-center">
        Select a client to view its reports.
      </div>
    );
  }

  if (loading && reports.length === 0) {
    return (
      <div className="text-sm text-zinc-500 dark:text-zinc-400 py-4 text-center">Loading…</div>
    );
  }

  if (error) {
    return <div className="text-sm text-red-600 dark:text-red-400 py-2">{error}</div>;
  }

  if (reports.length === 0) {
    return (
      <div className="text-sm text-zinc-500 dark:text-zinc-400 py-4 text-center flex items-center justify-center gap-2">
        <Activity className="w-4 h-4" />
        No reports yet.
      </div>
    );
  }

  return (
    <div className="space-y-1 max-h-[500px] overflow-y-auto font-mono text-xs">
      {reports.map((r) => (
        <div
          key={r.id}
          className="flex items-start gap-2 py-1 border-b border-zinc-100 dark:border-zinc-700/50 last:border-0"
        >
          <span className="shrink-0 text-zinc-500 dark:text-zinc-400">
            {/* slice(11, 19) = HH:MM:SS portion of toLocaleString() — date is
                redundant since these are all "recent" */}
            {formatTimestamp(r.ts).slice(11, 19)}
          </span>
          <span
            className={`shrink-0 px-1.5 rounded text-[10px] uppercase ${levelBadgeClass(r.level)}`}
          >
            {r.level}
          </span>
          <span className="text-zinc-700 dark:text-zinc-200 break-all">{r.text}</span>
        </div>
      ))}
    </div>
  );
}
