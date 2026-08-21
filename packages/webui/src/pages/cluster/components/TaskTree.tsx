import { Skull } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ClusterTask } from '../../../types';
import { formatTimestamp } from '../utils';
import { ClusterStatusBadge } from './ClusterStatusBadge';

export interface TaskGroupData {
  root: ClusterTask;
  children: ClusterTask[];
}

/**
 * Group tasks as parent → children (one level of depth). Roots first
 * (createdAt asc), children of each root also createdAt asc. A task whose
 * parentTaskId is missing from the set is treated as a root.
 */
export function groupTasks(tasks: ClusterTask[]): TaskGroupData[] {
  const taskIds = new Set(tasks.map((t) => t.id));
  const roots: ClusterTask[] = [];
  const childrenByParent = new Map<string, ClusterTask[]>();
  for (const t of tasks) {
    if (t.parentTaskId && taskIds.has(t.parentTaskId)) {
      const list = childrenByParent.get(t.parentTaskId) ?? [];
      list.push(t);
      childrenByParent.set(t.parentTaskId, list);
    } else {
      roots.push(t);
    }
  }
  const byCreatedAt = (a: ClusterTask, b: ClusterTask) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  roots.sort(byCreatedAt);
  for (const list of childrenByParent.values()) {
    list.sort(byCreatedAt);
  }
  return roots.map((root) => ({ root, children: childrenByParent.get(root.id) ?? [] }));
}

/** Flat (task, depth) view of the same grouping, for indent-style renderers. */
export function orderTasksAsTree(tasks: ClusterTask[]): Array<{ task: ClusterTask; depth: number }> {
  return groupTasks(tasks).flatMap(({ root, children }) => [
    { task: root, depth: 0 },
    ...children.map((child) => ({ task: child, depth: 1 })),
  ]);
}

const KILLABLE_STATUSES = new Set(['pending', 'claimed', 'running']);

type TaskKind = 'planner' | 'worker' | 'task';

const KIND_CHIP: Record<Exclude<TaskKind, 'task'>, { label: string; className: string }> = {
  planner: {
    label: 'planner',
    className: 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300',
  },
  worker: {
    label: 'worker',
    className: 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
  },
};

function TaskRow({
  task,
  kind,
  onClick,
  onKill,
}: {
  task: ClusterTask;
  kind: TaskKind;
  onClick: (task: ClusterTask) => void;
  onKill?: (taskId: string) => void;
}) {
  const preview = task.diffSummary || task.error || '';
  const killable = onKill && KILLABLE_STATUSES.has(task.status);
  const chip = kind === 'task' ? null : KIND_CHIP[kind];

  return (
    <div className="flex items-stretch">
      <button
        type="button"
        onClick={() => onClick(task)}
        className="flex-1 min-w-0 text-left px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors"
      >
        <div className="flex items-center gap-2 flex-wrap">
          {chip && (
            <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${chip.className}`}>
              {chip.label}
            </span>
          )}
          <span className="font-mono text-xs text-zinc-600 dark:text-zinc-300 shrink-0">{task.id.slice(0, 8)}</span>
          <ClusterStatusBadge status={task.status} />
          {task.workerTemplate && (
            <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400 shrink-0">{task.workerTemplate}</span>
          )}
          <span className="flex-1 min-w-0" />
          <time className="text-xs text-zinc-400 dark:text-zinc-500 shrink-0 tabular-nums">
            {formatTimestamp(task.completedAt ?? task.createdAt)}
          </time>
        </div>
        {preview && (
          <div
            className={`mt-1 text-xs leading-relaxed line-clamp-2 break-words ${
              task.error ? 'text-red-600 dark:text-red-400' : 'text-zinc-600 dark:text-zinc-400'
            }`}
          >
            {preview.slice(0, 400)}
            {preview.length > 400 ? '…' : ''}
          </div>
        )}
      </button>
      {killable && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onKill?.(task.id);
          }}
          className="shrink-0 px-2.5 flex items-center justify-center text-zinc-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
          aria-label="Kill task"
          title="Kill task"
        >
          <Skull className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * One parent task card with its subtasks nested inside. The planner's root
 * task heads the card (violet accent when it actually fanned out); worker
 * subtasks hang off a tree rail below it, full-width instead of indent-and-
 * truncate. `renderAfterTask` lets the caller append live extras (e.g. a
 * stdout tail) under any row.
 */
export function TaskGroup({
  root,
  childTasks,
  onTaskClick,
  onKill,
  renderAfterTask,
}: {
  root: ClusterTask;
  childTasks: ClusterTask[];
  onTaskClick: (task: ClusterTask) => void;
  onKill?: (taskId: string) => void;
  renderAfterTask?: (task: ClusterTask) => ReactNode;
}) {
  const hasChildren = childTasks.length > 0;

  return (
    <div
      className={`rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 overflow-hidden ${
        hasChildren ? 'border-l-2 border-l-violet-400 dark:border-l-violet-500' : ''
      }`}
    >
      <TaskRow task={root} kind={hasChildren ? 'planner' : 'task'} onClick={onTaskClick} onKill={onKill} />
      {renderAfterTask?.(root)}
      {hasChildren && (
        <div className="border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50/70 dark:bg-zinc-900/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-zinc-400 dark:text-zinc-500 mb-1.5">
            subtasks ({childTasks.length})
          </div>
          <div className="flex flex-col">
            {childTasks.map((child, i) => {
              const isLast = i === childTasks.length - 1;
              return (
                <div key={child.id} className="relative pl-6">
                  {/* Tree rail: vertical segment + elbow into the row */}
                  <div
                    className={`absolute left-2 top-0 w-px bg-zinc-300 dark:bg-zinc-600 ${isLast ? 'h-[1.15rem]' : 'bottom-0'}`}
                  />
                  <div className="absolute left-2 top-[1.15rem] w-3.5 h-px bg-zinc-300 dark:bg-zinc-600" />
                  <div className="mb-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 overflow-hidden">
                    <TaskRow task={child} kind="worker" onClick={onTaskClick} onKill={onKill} />
                    {renderAfterTask?.(child)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Legacy indent-style row (kept for TicketDetailPanel). Click the row to open
 * TaskOutputModal with full details — no inline expansion (avoid nested
 * scrolling inside the ticket detail pane).
 */
export function TaskTreeRow({
  task,
  depth,
  onClick,
  onKill,
}: {
  task: ClusterTask;
  depth: number;
  onClick: (task: ClusterTask) => void;
  onKill?: (taskId: string) => void;
}) {
  return (
    <div
      style={{ marginLeft: depth * 20 }}
      className="w-full rounded border border-zinc-200 dark:border-zinc-700 overflow-hidden"
    >
      <TaskRow task={task} kind={depth > 0 ? 'worker' : 'task'} onClick={onClick} onKill={onKill} />
    </div>
  );
}
