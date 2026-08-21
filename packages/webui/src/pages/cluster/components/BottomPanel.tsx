import { ChevronDown, ChevronUp, Lock } from 'lucide-react';
import { useState } from 'react';

import type { ClusterEventEntry, ClusterLock } from '../../../types';
import { formatClusterEventSummary } from '../utils';
import { LocksPanel } from './LocksPanel';

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

type Section = 'events' | 'locks' | null;

function SectionButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      className={`shrink-0 h-full flex items-center gap-1.5 px-2 text-xs font-semibold transition-colors ${
        active
          ? 'text-zinc-900 dark:text-zinc-100'
          : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Bottom fold-out panel with two sections: the event log and the lock
 * billboard. Collapsed by default to a one-line bar showing the latest event
 * (events arrive newest-first from the hub); expanding either section reveals
 * a fixed-height scrollable panel so neither competes with the main
 * Jobs/Workers area for vertical space.
 */
export function BottomPanel({
  events,
  typeFilter,
  onTypeFilterChange,
  locks,
}: {
  events: ClusterEventEntry[] | null;
  typeFilter: string;
  onTypeFilterChange: (value: string) => void;
  locks: ClusterLock[] | null;
}) {
  const [section, setSection] = useState<Section>(null);
  const toggle = (s: Exclude<Section, null>) => setSection((cur) => (cur === s ? null : s));
  const latest = events?.[0];
  const lockCount = locks?.length ?? 0;

  return (
    <div className="shrink-0 border-t border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
      <div className="px-2 h-9 flex items-center gap-1">
        <SectionButton active={section === 'events'} onClick={() => toggle('events')}>
          {section === 'events' ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          Events
          <span className="font-mono font-normal text-zinc-500 dark:text-zinc-400">({events?.length ?? 0})</span>
          {typeFilter && (
            <span className="px-1.5 py-0.5 rounded-md bg-zinc-200/90 dark:bg-zinc-700/80 text-[10px] font-mono font-normal text-zinc-800 dark:text-zinc-100">
              {typeFilter}
            </span>
          )}
        </SectionButton>
        <SectionButton active={section === 'locks'} onClick={() => toggle('locks')}>
          {section === 'locks' ? <ChevronDown className="w-4 h-4" /> : <Lock className="w-3.5 h-3.5" />}
          Locks
          <span
            className={`font-mono font-normal ${
              lockCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-500 dark:text-zinc-400'
            }`}
          >
            ({lockCount})
          </span>
        </SectionButton>
        {section === null && latest && (
          <button
            type="button"
            onClick={() => setSection('events')}
            className="flex-1 min-w-0 h-full flex items-center gap-2 text-left pl-2 border-l border-zinc-200 dark:border-zinc-700"
          >
            <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-zinc-200/90 dark:bg-zinc-700/80 text-[10px] font-mono text-zinc-800 dark:text-zinc-100 max-w-[8.5rem] truncate">
              {latest.type}
            </span>
            <span className="min-w-0 truncate text-xs text-zinc-500 dark:text-zinc-400">
              {formatClusterEventSummary(latest)}
            </span>
            <time className="ml-auto shrink-0 pr-2 text-[10px] text-zinc-400 dark:text-zinc-500 tabular-nums">
              {new Date(latest.timestamp).toLocaleTimeString()}
            </time>
          </button>
        )}
        {section === 'events' && (
          <select
            value={typeFilter}
            onChange={(e) => onTypeFilterChange(e.target.value)}
            className="ml-auto mr-2 shrink-0 px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs max-w-[140px]"
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
      {section === 'events' && (
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
      {section === 'locks' && (
        <div className="max-h-[36vh] overflow-y-auto overscroll-contain border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/40 px-4 py-3">
          <LocksPanel locks={locks} />
        </div>
      )}
    </div>
  );
}
