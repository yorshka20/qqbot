import type { ClusterLock } from '../../../types';

export function LocksPanel({ locks }: { locks: ClusterLock[] | null }) {
  if (!locks) {
    return <div className="text-sm text-zinc-500 dark:text-zinc-400">-</div>;
  }
  if (locks.length === 0) {
    return <div className="text-sm text-zinc-500 dark:text-zinc-400">No active locks</div>;
  }
  return (
    <div className="flex flex-col gap-2 lg:flex-1 lg:min-h-0 lg:overflow-y-auto overscroll-contain [&>*]:shrink-0">
      {locks
        .slice()
        .sort((a, b) => a.filePath.localeCompare(b.filePath))
        .map((l) => (
          <div
            key={l.filePath}
            className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/30 px-3 py-2"
          >
            <div className="font-mono text-xs text-zinc-700 dark:text-zinc-200 break-all">{l.filePath}</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              by {l.workerId} · task {l.taskId ?? '-'}
            </div>
          </div>
        ))}
    </div>
  );
}
