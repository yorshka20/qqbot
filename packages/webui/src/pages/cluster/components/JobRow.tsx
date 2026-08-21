import { ChevronDown, ChevronRight, Dot, Skull, Users } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

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

const NON_TERMINAL_TASK_STATUSES = new Set(['pending', 'claimed', 'running']);
const NON_TERMINAL_JOB_STATUSES = new Set(['pending', 'running']);

/** Always-visible tail of a running task's live stdout, auto-scrolled to bottom. */
function TaskOutputTail({ task }: { task: ClusterTask }) {
  const ref = useRef<HTMLPreElement>(null);
  const output = task.output ?? '';
  const tail = useMemo(() => output.split(/\r?\n/).slice(-40).join('\n'), [output]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on tail content, not read inside the effect body
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail]);

  const kb = ((task.outputBytes ?? output.length) / 1024).toFixed(1);

  return (
    <div className="mt-1 mb-2 ml-2">
      <div className="text-[10px] text-zinc-400 dark:text-zinc-500 font-mono mb-0.5">
        {kb}KB{task.outputTruncated ? ' · truncated' : ''}
      </div>
      <pre
        ref={ref}
        className="text-[11px] font-mono leading-relaxed bg-zinc-950 dark:bg-black text-zinc-100 rounded-md p-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words"
      >
        {tail || '(no output yet)'}
      </pre>
    </div>
  );
}

export function JobRow({
  job,
  onTaskClick,
  onKillJob,
  onKillTask,
}: {
  job: ClusterJob;
  onTaskClick: (task: ClusterTask) => void;
  onKillJob?: (jobId: string) => void;
  onKillTask?: (taskId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<ClusterJobWithDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [workersModalOpen, setWorkersModalOpen] = useState(false);

  const loadDetail = useCallback(async () => {
    setDetailError(null);
    try {
      const d = await getClusterJob(job.id);
      setDetail(d);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e));
    }
  }, [job.id]);

  const toggle = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (detail) return;
    setLoadingDetail(true);
    await loadDetail();
    setLoadingDetail(false);
  }, [expanded, detail, loadDetail]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional drop
  useEffect(() => {
    setDetail(null);
  }, [job.tasksCompleted, job.tasksFailed, job.status]);

  // Live polling while an expanded job is still active — keeps the task
  // list and per-task output tails fresh without the operator opening a
  // modal. Scoped to expanded, non-terminal rows only.
  useEffect(() => {
    if (!expanded || !NON_TERMINAL_JOB_STATUSES.has(job.status)) return;
    const t = window.setInterval(() => loadDetail(), 2000);
    return () => window.clearInterval(t);
  }, [expanded, job.status, loadDetail]);

  const idShort = (job.id ?? '').slice(0, 8) || '(unknown)';
  const preview = job.ticketId || previewDescription(job.description);
  const completed = job.tasksCompleted ?? 0;
  const failed = job.tasksFailed ?? 0;
  const total = job.taskCount ?? 0;
  const workers = detail?.workers ?? [];
  const killableJob = NON_TERMINAL_JOB_STATUSES.has(job.status);

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
            <div className="flex items-center gap-2">
              {killableJob && onKillJob && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onKillJob(job.id);
                  }}
                  className="shrink-0 inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-red-200 dark:border-red-800 bg-white dark:bg-zinc-800 hover:bg-red-50 dark:hover:bg-red-950/30 text-red-700 dark:text-red-300 transition-colors"
                >
                  <Skull className="w-3 h-3" />
                  <span>Kill job</span>
                </button>
              )}
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
                <div key={task.id}>
                  <TaskTreeRow task={task} depth={depth} onClick={onTaskClick} onKill={onKillTask} />
                  {NON_TERMINAL_TASK_STATUSES.has(task.status) && <TaskOutputTail task={task} />}
                </div>
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
