import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react';
import { useState } from 'react';
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
 * One row of the indented task tree. Expandable card — click the header
 * to toggle inline expansion showing full description and output.
 * The `onClick` prop opens the TaskOutputModal for a dedicated view.
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
  const [expanded, setExpanded] = useState(false);
  const hasContent = !!(task.description || task.output || task.error);

  return (
    <div
      style={{ marginLeft: depth * 20 }}
      className="rounded border border-zinc-200 dark:border-zinc-700 overflow-hidden"
    >
      {/* Summary header — click to expand/collapse */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-2 py-1 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors"
      >
        <div className="flex items-center gap-2">
          {hasContent ? (
            expanded ? (
              <ChevronDown className="w-3 h-3 text-zinc-400 shrink-0" />
            ) : (
              <ChevronRight className="w-3 h-3 text-zinc-400 shrink-0" />
            )
          ) : (
            <span className="w-3 h-3 shrink-0" />
          )}
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
        {/* Collapsed preview — only when not expanded */}
        {!expanded && task.output && (
          <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400 truncate">
            {task.output.slice(0, 120)}
            {task.output.length > 120 ? '…' : ''}
          </div>
        )}
        {!expanded && !task.output && task.error && (
          <div className="mt-1 text-xs text-red-600 dark:text-red-400 truncate">{task.error}</div>
        )}
      </button>

      {/* Expanded detail — full content inline */}
      {expanded && (
        <div className="border-t border-zinc-200 dark:border-zinc-700 px-3 py-2 space-y-3 bg-zinc-50/50 dark:bg-zinc-900/30">
          {task.description && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400 font-medium">
                  Description (input prompt)
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClick(task);
                  }}
                  className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
                >
                  open in modal
                </button>
              </div>
              <pre className="text-xs whitespace-pre-wrap break-words bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded p-2 max-h-[300px] overflow-y-auto text-zinc-700 dark:text-zinc-200">
                {task.description}
              </pre>
            </div>
          )}
          {task.output && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400 font-medium mb-1">
                Output
              </div>
              <pre className="text-xs whitespace-pre-wrap break-words bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded p-2 max-h-[400px] overflow-y-auto text-zinc-700 dark:text-zinc-200">
                {task.output}
              </pre>
            </div>
          )}
          {task.error && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-red-500 dark:text-red-400 font-medium mb-1">
                Error
              </div>
              <pre className="text-xs whitespace-pre-wrap break-words bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded p-2 text-red-700 dark:text-red-300">
                {task.error}
              </pre>
            </div>
          )}
          {task.metadata != null && (
            <details className="text-xs">
              <summary className="cursor-pointer text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
                Raw metadata
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-words bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded p-2 max-h-[200px] overflow-y-auto text-zinc-600 dark:text-zinc-300">
                {typeof task.metadata === 'string' ? task.metadata : JSON.stringify(task.metadata, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
