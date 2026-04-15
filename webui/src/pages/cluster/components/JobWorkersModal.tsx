import { useMemo, useState } from 'react';

import type { EnrichedWorkerRegistration } from '../../../types';
import { formatEpoch } from '../utils';
import { ClusterStatusBadge } from './ClusterStatusBadge';
import { Modal } from './Modal';
import { WorkerDetailModal } from './WorkerDetailModal';

interface JobWorkersModalProps {
  jobId: string;
  jobPreview?: string;
  workers: EnrichedWorkerRegistration[];
  onClose: () => void;
}

const ROLE_ORDER = ['planner', 'coder', 'executor', 'reviewer'];

const ROLE_STYLES: Record<string, string> = {
  planner: 'bg-violet-100 dark:bg-violet-950/50 text-violet-700 dark:text-violet-300',
  coder: 'bg-sky-100 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300',
  executor: 'bg-sky-100 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300',
  reviewer: 'bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300',
};

const REPORT_ICONS: Record<string, string> = {
  completed: '✓',
  working: '…',
  failed: '✗',
  blocked: '🚫',
};

const REPORT_COLORS: Record<string, string> = {
  completed: 'text-emerald-600 dark:text-emerald-400',
  working: 'text-sky-600 dark:text-sky-400',
  failed: 'text-red-600 dark:text-red-400',
  blocked: 'text-amber-600 dark:text-amber-400',
};

function roleIndex(role: string | undefined): number {
  if (!role) return ROLE_ORDER.length;
  const idx = ROLE_ORDER.indexOf(role);
  return idx === -1 ? ROLE_ORDER.length : idx;
}

function formatDuration(worker: EnrichedWorkerRegistration): string {
  const start = worker.stats?.registeredAt ?? worker.spawnedAt;
  const end = worker.exitedAt ?? worker.lastSeen;
  if (!start || !end || end <= start) return '';
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h${rm}m`;
}

export function JobWorkersModal({ jobId, jobPreview, workers, onClose }: JobWorkersModalProps) {
  const [selectedWorker, setSelectedWorker] = useState<EnrichedWorkerRegistration | null>(null);

  const groups = useMemo(() => {
    const byRole = new Map<string, EnrichedWorkerRegistration[]>();
    for (const w of workers) {
      const key = w.role || 'unknown';
      const arr = byRole.get(key);
      if (arr) arr.push(w);
      else byRole.set(key, [w]);
    }
    for (const arr of byRole.values()) {
      arr.sort((a, b) => {
        const ra = a.stats?.registeredAt ?? a.spawnedAt ?? 0;
        const rb = b.stats?.registeredAt ?? b.spawnedAt ?? 0;
        return ra - rb;
      });
    }
    return Array.from(byRole.entries()).sort(([a], [b]) => roleIndex(a) - roleIndex(b));
  }, [workers]);

  const jobIdShort = jobId.slice(0, 8);

  const header = (
    <>
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 shrink-0">Workers</h2>
      <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400 shrink-0">{jobIdShort}</span>
      {jobPreview && (
        <span className="flex-1 min-w-0 truncate text-xs text-zinc-600 dark:text-zinc-300" title={jobPreview}>
          {jobPreview}
        </span>
      )}
      <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
        {workers.length} worker{workers.length === 1 ? '' : 's'}
      </span>
    </>
  );

  return (
    <Modal onClose={onClose} header={header} size="lg" zIndex={60}>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 space-y-4">
        {workers.length === 0 && (
          <div className="text-sm text-zinc-500 dark:text-zinc-400 text-center py-8">No workers for this job</div>
        )}

        {groups.map(([role, arr]) => (
          <div key={role} className="min-w-0">
            <div className="flex items-center gap-2 mb-2 text-xs">
              <span
                className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${ROLE_STYLES[role] ?? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300'}`}
              >
                {role}
              </span>
              <span className="text-zinc-500 dark:text-zinc-400 tabular-nums">({arr.length})</span>
            </div>
            <div className="flex flex-col gap-1 min-w-0">
              {arr.map((w) => {
                const reportStatus = w.lastReportStatus ?? '';
                const icon = REPORT_ICONS[reportStatus];
                const iconColor = REPORT_COLORS[reportStatus] ?? 'text-zinc-400';
                const duration = formatDuration(w);
                return (
                  <button
                    type="button"
                    key={w.workerId}
                    onClick={() => setSelectedWorker(w)}
                    className="ml-6 mr-2 min-w-0 flex items-center gap-2 text-xs px-2.5 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-800/30 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 text-left transition-colors overflow-hidden"
                  >
                    <span
                      className="font-mono text-zinc-500 dark:text-zinc-400 shrink-0 max-w-[7rem] truncate"
                      title={w.workerId}
                    >
                      {w.workerId}
                    </span>
                    <ClusterStatusBadge status={w.status ?? 'unknown'} />
                    {w.templateName && (
                      <span
                        className="shrink-0 px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-mono text-[10px] max-w-[9rem] truncate"
                        title={w.templateName}
                      >
                        {w.templateName}
                      </span>
                    )}
                    {duration && (
                      <span className="shrink-0 text-zinc-500 dark:text-zinc-400 tabular-nums font-mono text-[10px]">
                        {duration}
                      </span>
                    )}
                    {icon && <span className={`shrink-0 font-mono ${iconColor}`}>{icon}</span>}
                    <span
                      className="flex-1 min-w-0 truncate text-zinc-700 dark:text-zinc-200"
                      title={w.lastReportSummary}
                    >
                      {w.lastReportSummary ?? (
                        <span className="text-zinc-400 dark:text-zinc-500 italic">no report</span>
                      )}
                    </span>
                    <span className="shrink-0 text-zinc-400 dark:text-zinc-500 tabular-nums text-[10px]">
                      {formatEpoch(w.stats?.registeredAt ?? w.spawnedAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {selectedWorker && <WorkerDetailModal worker={selectedWorker} onClose={() => setSelectedWorker(null)} />}
    </Modal>
  );
}
