import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

import type { ClusterEventEntry } from '../../../types';
import { formatClusterEventSummary } from '../utils';

const EVENT_TYPE_OPTIONS = [
  'worker_joined',
  'worker_left',
  'task_completed',
  'task_failed',
  'task_blocked',
  'worker_progress',
  'lock_acquired',
  'lock_released',
  'help_request',
  'message',
];

function EventRow({ ev }: { ev: ClusterEventEntry }) {
  return (
    <div className="shrink-0 rounded-lg border border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 px-2 py-2 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
      <div className="flex items-start gap-2">
        <span className="text-zinc-400 dark:text-zinc-500 shrink-0 w-11 tabular-nums">#{ev.seq}</span>
        <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-zinc-200/90 dark:bg-zinc-700/80 text-[10px] font-mono text-zinc-800 dark:text-zinc-100 max-w-[8.5rem] truncate">
          {ev.type}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-zinc-800 dark:text-zinc-100 leading-snug break-words">
            {formatClusterEventSummary(ev)}
          </div>
          {ev.sourceWorkerId ? (
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400 font-mono truncate mt-0.5">
              {ev.sourceWorkerId}
            </div>
          ) : null}
        </div>
        <time className="text-zinc-400 dark:text-zinc-500 shrink-0 text-[10px] tabular-nums whitespace-nowrap">
          {new Date(ev.timestamp).toLocaleTimeString()}
        </time>
      </div>
      <details className="mt-1.5 ml-[3.25rem]">
        <summary className="cursor-pointer text-[10px] text-zinc-500 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 select-none">
          Raw payload
        </summary>
        <pre className="mt-1 p-2 rounded-md bg-zinc-100 dark:bg-zinc-950 text-[10px] leading-relaxed text-zinc-700 dark:text-zinc-300 overflow-x-auto whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
          {JSON.stringify(ev.data, null, 2)}
        </pre>
      </details>
    </div>
  );
}

/**
 * Bottom fold-out event log. Collapsed by default to a one-line bar showing
 * the latest event (events arrive newest-first from the hub); expanding
 * reveals a fixed-height scrollable panel so the log never competes with the
 * main Jobs/Workers area for vertical space.
 */
export function EventsDrawer({
  events,
  typeFilter,
  onTypeFilterChange,
}: {
  events: ClusterEventEntry[] | null;
  typeFilter: string;
  onTypeFilterChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const latest = events?.[0];

  return (
    <div className="shrink-0 border-t border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
      <div className="px-4 h-9 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex-1 min-w-0 h-full flex items-center gap-2 text-left"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="w-4 h-4 text-zinc-500 shrink-0" />
          ) : (
            <ChevronUp className="w-4 h-4 text-zinc-500 shrink-0" />
          )}
          <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 shrink-0">Events</span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400 font-mono shrink-0">({events?.length ?? 0})</span>
          {typeFilter && (
            <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-zinc-200/90 dark:bg-zinc-700/80 text-[10px] font-mono text-zinc-800 dark:text-zinc-100">
              {typeFilter}
            </span>
          )}
          {!open && latest && (
            <>
              <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-zinc-200/90 dark:bg-zinc-700/80 text-[10px] font-mono text-zinc-800 dark:text-zinc-100 max-w-[8.5rem] truncate">
                {latest.type}
              </span>
              <span className="min-w-0 truncate text-xs text-zinc-500 dark:text-zinc-400">
                {formatClusterEventSummary(latest)}
              </span>
              <time className="ml-auto shrink-0 text-[10px] text-zinc-400 dark:text-zinc-500 tabular-nums">
                {new Date(latest.timestamp).toLocaleTimeString()}
              </time>
            </>
          )}
        </button>
        {open && (
          <select
            value={typeFilter}
            onChange={(e) => onTypeFilterChange(e.target.value)}
            className="shrink-0 px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs max-w-[140px]"
          >
            <option value="">All types</option>
            {EVENT_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
      </div>
      {open && (
        <div className="h-[36vh] overflow-y-auto overscroll-contain border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/40 px-4 py-2 flex flex-col gap-1">
          {!events ? (
            <div className="text-sm text-zinc-500 dark:text-zinc-400">-</div>
          ) : events.length === 0 ? (
            <div className="text-sm text-zinc-500 dark:text-zinc-400">
              No events
              {typeFilter && ` matching "${typeFilter}"`}
            </div>
          ) : (
            events.map((ev) => <EventRow key={`${ev.seq}-${ev.timestamp}`} ev={ev} />)
          )}
        </div>
      )}
    </div>
  );
}
