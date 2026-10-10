import type { AgentTaskRecord } from '../../../types';
import { agentStatusBadgeClass, agentStatusLabel, formatDuration, formatTimestamp } from '../utils';

/**
 * Left pane: compact rows, one per task, newest first (the backend already orders them).
 * A row answers "what was this, how did it go, how long did it take" without a click;
 * the prompt is clipped to keep rows scannable.
 */
export function AgentTaskList({
  tasks,
  selectedId,
  now,
  onSelect,
}: {
  tasks: AgentTaskRecord[];
  selectedId: string | null;
  /** Ticks so a running row's duration keeps counting between polls. */
  now: number;
  onSelect: (id: string) => void;
}) {
  if (tasks.length === 0) {
    return (
      <div className="text-sm text-zinc-500 dark:text-zinc-400 py-8 text-center px-4">
        还没有任务记录。在群里用 <span className="font-mono">/claude</span>、<span className="font-mono">/codex</span>{' '}
        或 <span className="font-mono">/dsh</span> 起一个任务试试。
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {tasks.map((task) => (
        // biome-ignore lint/a11y/useSemanticElements: a nested <button> would be invalid HTML; div+role=button is the intentional workaround used by the sibling lists
        <div
          key={task.id}
          onClick={() => onSelect(task.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect(task.id);
            }
          }}
          role="button"
          tabIndex={0}
          className={`px-4 py-3 border-b border-zinc-100 dark:border-zinc-700/60 cursor-pointer transition-colors ${
            task.id === selectedId ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-zinc-50 dark:hover:bg-zinc-700/40'
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${agentStatusBadgeClass(task.status)}`}>
              {agentStatusLabel(task.status)}
            </span>
            <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{task.executor}</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{task.model}</span>
            <div className="flex-1" />
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono shrink-0">
              {formatDuration(task, now)}
            </span>
          </div>
          <div className="text-sm text-zinc-800 dark:text-zinc-200 line-clamp-2 break-words">{task.prompt}</div>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">
              {formatTimestamp(task.createdAt)}
            </span>
            {task.projectAlias ? (
              <span className="px-1.5 py-0.5 rounded text-[11px] bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
                {task.projectAlias}
              </span>
            ) : (
              <span className="px-1.5 py-0.5 rounded text-[11px] bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                工作区
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
