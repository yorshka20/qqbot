import { ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { getClusterJob } from '../../../api';
import type { ClusterJob, ClusterJobWithTasks, ClusterTask } from '../../../types';
import { formatTimestamp } from '../utils';
import { ClusterStatusBadge } from './ClusterStatusBadge';
import { orderTasksAsTree, TaskTreeRow } from './TaskTree';

export function JobRow({
  job,
  onTaskClick,
}: {
  job: ClusterJob;
  onTaskClick: (task: ClusterTask) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<ClusterJobWithTasks | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

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

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/30 overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />
        )}
        <div className="font-mono text-xs text-zinc-700 dark:text-zinc-200">{job.id.slice(0, 8)}</div>
        <ClusterStatusBadge status={job.status} />
        <div className="text-sm text-zinc-800 dark:text-zinc-100 truncate min-w-0 flex-1">{job.description}</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400 shrink-0 font-mono">
          {job.tasksCompleted}✓ {job.tasksFailed}✗ /{job.taskCount}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-zinc-200 dark:border-zinc-700 px-3 py-2 bg-zinc-50/50 dark:bg-zinc-900/50">
          <div className="grid grid-cols-2 gap-2 text-xs text-zinc-500 dark:text-zinc-400 mb-2">
            <div>
              project: <span className="font-mono">{job.project}</span>
            </div>
            <div>created: {formatTimestamp(job.createdAt)}</div>
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
    </div>
  );
}
