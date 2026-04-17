import { GitBranch } from 'lucide-react';
import type { ClusterTask } from '../../../types';
import { formatTimestamp } from '../utils';
import { ClusterStatusBadge } from './ClusterStatusBadge';

/**
 * Phase 3: order tasks as a parent-children tree (one level of depth).
 * Roots first (createdAt asc), with each root immediately followed by
 * its children (also createdAt asc).
 */
export function orderTasksAsTree(tasks: ClusterTask[]): Array<{ task: ClusterTask; depth: number }> {
  const byParent = new Map<string, ClusterTask[]>();
  const taskIds = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    const key = t.parentTaskId && taskIds.has(t.parentTaskId) ? t.parentTaskId : '__root__';
    const list = byParent.get(key) ?? [];
    list.push(t);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }
  const out: Array<{ task: ClusterTask; depth: number }> = [];
  for (const root of byParent.get('__root__') ?? []) {
    out.push({ task: root, depth: 0 });
    for (const child of byParent.get(root.id) ?? []) {
      out.push({ task: child, depth: 1 });
    }
  }
  return out;
}

/**
 * One row of the indented task tree. Click the row to open TaskOutputModal
 * with full details — no inline expansion (avoid nested scrolling inside
 * JobRow / TicketDetail).
 */
export function TaskTreeRow({
  task,
  depth,
  onClick,
}: {
  task: ClusterTask;
  depth: number;
  onClick: (task: ClusterTask) => void;
}) {
  const preview = task.diffSummary || task.error || '';

  return (
    <button
      type="button"
      style={{ marginLeft: depth * 20 }}
      onClick={() => onClick(task)}
      className="w-full text-left rounded border border-zinc-200 dark:border-zinc-700 px-2 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors"
    >
      <div className="flex items-center gap-2">
        {depth > 0 && <GitBranch className="w-3 h-3 text-zinc-400 shrink-0" />}
        <div className="font-mono text-xs text-zinc-600 dark:text-zinc-300 shrink-0">{task.id.slice(0, 8)}</div>
        <ClusterStatusBadge status={task.status} />
        {task.workerTemplate && (
          <div className="text-xs font-mono text-zinc-500 dark:text-zinc-400 shrink-0">{task.workerTemplate}</div>
        )}
        <div className="flex-1 min-w-0" />
        <div className="text-xs text-zinc-400 dark:text-zinc-500 shrink-0 tabular-nums">
          {formatTimestamp(task.completedAt ?? task.createdAt)}
        </div>
      </div>
      {preview && (
        <div
          className={`mt-1 text-xs truncate ${task.error ? 'text-red-600 dark:text-red-400' : 'text-zinc-600 dark:text-zinc-400'}`}
        >
          {preview.slice(0, 160)}
          {preview.length > 160 ? '…' : ''}
        </div>
      )}
    </button>
  );
}
