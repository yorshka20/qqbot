import { GitBranch } from 'lucide-react';
import type { ClusterTask } from '../../../types';
import { formatTimestamp } from '../utils';
import { ClusterStatusBadge } from './ClusterStatusBadge';

/**
 * Phase 3: order tasks as a parent-children tree (one level of depth).
 * Roots first (createdAt asc), with each root immediately followed by
 * its children (also createdAt asc).
 *
 * Children whose parent is missing from the slice (e.g. parent is in a
 * different job somehow, which shouldn't happen but defensively) get
 * promoted to root so they don't disappear.
 *
 * Used by both the cluster page's JobRow (expandable per-job tree) and
 * the tickets page's detail panel (per-ticket task tree). The shape is
 * `Array<{task, depth}>` rather than nested objects so callers can map
 * it straight to a flat list of indented rows without recursive render.
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
 * One row of the indented task tree. Pure presentation — caller hands in
 * the task + its computed depth (from orderTasksAsTree) and an onClick
 * handler. The click target is the whole row, so callers typically open
 * a TaskOutputModal or scroll to the task on click.
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
  return (
    <button
      type="button"
      onClick={() => onClick(task)}
      style={{ marginLeft: depth * 20 }}
      className="rounded border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-left hover:bg-white dark:hover:bg-zinc-800 transition-colors"
    >
      <div className="flex items-center gap-2">
        {depth > 0 && <GitBranch className="w-3 h-3 text-zinc-400 shrink-0" />}
        <div className="font-mono text-xs text-zinc-600 dark:text-zinc-300">{task.id.slice(0, 8)}</div>
        <ClusterStatusBadge status={task.status} />
        {task.workerTemplate && (
          <div className="text-xs font-mono text-zinc-500 dark:text-zinc-400">{task.workerTemplate}</div>
        )}
        <div className="flex-1" />
        <div className="text-xs text-zinc-400 dark:text-zinc-500">
          {formatTimestamp(task.completedAt ?? task.createdAt)}
        </div>
      </div>
      {task.output && (
        <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400 truncate">
          {task.output.slice(0, 120)}
          {task.output.length > 120 ? '…' : ''}
        </div>
      )}
      {task.error && <div className="mt-1 text-xs text-red-600 dark:text-red-400 truncate">{task.error}</div>}
    </button>
  );
}
