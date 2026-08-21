import type { ClusterLock } from '../../../types';

export function LocksPanel({ locks }: { locks: ClusterLock[] | null }) {
  if (!locks || locks.length === 0) {
    return <div className="text-sm text-zinc-500 dark:text-zinc-400">No active locks</div>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
      {locks
        .slice()
        .sort((a, b) => a.filePath.localeCompare(b.filePath))
        .map((l) => (
          <div
            key={l.filePath}
            className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/40 px-3 py-2"
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
