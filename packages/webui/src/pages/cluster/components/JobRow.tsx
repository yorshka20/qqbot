import { ChevronDown, ChevronRight, Dot, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { getClusterJob } from '../../../api';
import type { ClusterJob, ClusterJobWithDetail, ClusterTask } from '../../../types';
import { formatTimestamp } from '../utils';
import { ClusterStatusBadge } from './ClusterStatusBadge';
import { JobWorkersModal } from './JobWorkersModal';
import { orderTasksAsTree, TaskTreeRow } from './TaskTree';

/**
 * Produce a single-line preview of the job description for the collapsed row.
 * Strips leading YAML frontmatter (--- ... ---) and markdown heading hashes so
 * the visible line is the first real sentence of the user's ask instead of
 * `--- estimatedComplexity: high --- ## Goal`.
 */
function previewDescription(raw: string | undefined): string {
  if (!raw) return '';
  const stripped = raw.replace(/^---[\s\S]*?---\s*/, '').trim();
  const firstLine = stripped
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0);
  return firstLine ?? stripped;
}

export function JobRow({ job, onTaskClick }: { job: ClusterJob; onTaskClick: (task: ClusterTask) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<ClusterJobWithDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [workersModalOpen, setWorkersModalOpen] = useState(false);

  const toggle = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (detail) return;
    setLoadingDetail(true);
    setDetailError(null);
    try {
      const d = await getClusterJob(job.id);
      setDetail(d);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDetail(false);
    }
  }, [expanded, detail, job.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional drop
  useEffect(() => {
    setDetail(null);
  }, [job.tasksCompleted, job.tasksFailed, job.status]);

  const idShort = (job.id ?? '').slice(0, 8) || '(unknown)';
  const preview = job.ticketId || previewDescription(job.description);
  const completed = job.tasksCompleted ?? 0;
  const failed = job.tasksFailed ?? 0;
  const total = job.taskCount ?? 0;
  const workers = detail?.workers ?? [];

  return (
    <div className="shrink-0 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/30 overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        className="w-full min-h-10 px-3 py-2 flex items-center gap-2 text-left text-zinc-800 dark:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />
        )}
        <span className="font-mono text-xs text-zinc-700 dark:text-zinc-200 shrink-0">{idShort}</span>
        <ClusterStatusBadge status={job.status ?? 'unknown'} />
        <span className="text-sm truncate min-w-0 flex-1" title={job.description}>
          {preview}
        </span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400 shrink-0 font-mono tabular-nums">
          {job.completedAt ? formatTimestamp(job.completedAt) : ''}
        </span>
        <Dot />
        <span className="text-xs text-zinc-500 dark:text-zinc-400 shrink-0 font-mono tabular-nums">
          {completed}✓ {failed}✗ /{total}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-zinc-200 dark:border-zinc-700 px-3 py-2 bg-zinc-50/50 dark:bg-zinc-900/50">
          <div className="flex items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400 mb-2">
            <div className="flex items-center gap-3">
              <span>
                project: <span className="font-mono">{job.project}</span>
              </span>
              <span>created: {formatTimestamp(job.createdAt)}</span>
            </div>
            {workers.length > 0 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setWorkersModalOpen(true);
                }}
                className="shrink-0 inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 transition-colors"
              >
                <Users className="w-3 h-3" />
                <span>Workers ({workers.length})</span>
              </button>
            )}
          </div>
          {loadingDetail && <div className="text-xs text-zinc-500 dark:text-zinc-400">Loading tasks...</div>}
          {detailError && <div className="text-xs text-red-600 dark:text-red-400">{detailError}</div>}
          {detail && detail.tasks.length === 0 && (
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              No tasks (job completed and tasks were drained from activeTasks)
            </div>
          )}
          {detail && detail.tasks.length > 0 && (
            <div className="flex flex-col gap-1">
              {orderTasksAsTree(detail.tasks).map(({ task, depth }) => (
                <TaskTreeRow key={task.id} task={task} depth={depth} onClick={onTaskClick} />
              ))}
            </div>
          )}
        </div>
      )}
      {workersModalOpen && (
        <JobWorkersModal
          jobId={job.id}
          jobPreview={preview}
          workers={workers}
          onClose={() => setWorkersModalOpen(false)}
        />
      )}
    </div>
  );
}
