import { AlertCircle, CheckCircle2, Clock, Pause } from 'lucide-react';

import type { ClusterEventEntry, ReportEventData } from '../../../types';
import { ClusterStatusBadge } from './ClusterStatusBadge';

const REPORT_EVENT_TYPES = new Set(['worker_progress', 'task_completed', 'task_failed', 'task_blocked']);

export function isReportEvent(ev: ClusterEventEntry): boolean {
  return REPORT_EVENT_TYPES.has(ev.type);
}

function ReportStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />;
    case 'failed':
      return <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />;
    case 'blocked':
      return <Pause className="w-3.5 h-3.5 text-purple-500 shrink-0" />;
    default:
      return <Clock className="w-3.5 h-3.5 text-blue-500 shrink-0" />;
  }
}

function ReportTimelineEntry({ event }: { event: ClusterEventEntry }) {
  const data = event.data as ReportEventData;
  const status = String(data.status ?? event.type.replace('task_', ''));
  const summary = data.summary?.trim() ?? '';
  const nextSteps = data.nextSteps?.trim() ?? '';
  const files = data.filesModified ?? [];
  const detail = data.detail;

  return (
    <div className="relative pl-6 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/30 rounded-r transition-colors">
      {/* Timeline dot — centered on the line; bg cuts line behind */}
      <div className="absolute left-3 top-2.5 -translate-x-1/2 p-0.5 rounded-full bg-white dark:bg-zinc-800">
        <ReportStatusIcon status={status} />
      </div>

      <div className="flex items-center gap-2 mb-0.5">
        <ClusterStatusBadge status={status} />
        <time className="text-[10px] text-zinc-400 dark:text-zinc-500 tabular-nums">
          {new Date(event.timestamp).toLocaleTimeString()}
        </time>
      </div>

      {summary && (
        <div className="text-xs text-zinc-700 dark:text-zinc-200 mt-1 whitespace-pre-wrap break-words line-clamp-3">
          {summary}
        </div>
      )}
      {nextSteps && <div className="text-[11px] text-blue-600 dark:text-blue-400 mt-0.5">→ {nextSteps}</div>}
      {files.length > 0 && (
        <div className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5 font-mono">files: {files.join(', ')}</div>
      )}
      {detail?.error != null && (
        <div className="text-[11px] text-red-600 dark:text-red-400 mt-0.5">error: {detail.error}</div>
      )}
      {detail?.blockReason != null && (
        <div className="text-[11px] text-purple-600 dark:text-purple-400 mt-0.5">blocked: {detail.blockReason}</div>
      )}
      {(detail?.testsRan != null || detail?.linesAdded != null) && (
        <div className="flex gap-3 text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5">
          {detail.linesAdded != null && <span>+{detail.linesAdded}</span>}
          {detail.linesRemoved != null && <span>-{detail.linesRemoved}</span>}
          {detail.testsRan != null && (
            <span>
              tests: {detail.testsPassed ?? 0}/{detail.testsRan}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function ReportTimeline({ events }: { events: ClusterEventEntry[] }) {
  if (events.length === 0) return null;

  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2 font-medium">
        Report Timeline ({events.length})
      </div>
      <div className="max-h-[300px] overflow-y-auto">
        {/* Inner relative wrapper so the line spans full content height, not just viewport */}
        <div className="relative pl-8">
          {/* Vertical timeline line at left:12px */}
          <div className="absolute left-3 top-0 bottom-0 w-0.5 bg-zinc-200 dark:bg-zinc-700" />
          {events.map((ev) => (
            <ReportTimelineEntry key={`${ev.seq}-${ev.timestamp}`} event={ev} />
          ))}
        </div>
      </div>
    </div>
  );
}
