import type { ClusterWorkerRegistration } from '../../../types';
import { WorkerBlock } from './WorkerBlock';

export function WorkersPanel({
  workers,
  activeWorkers,
  oldWorkers,
  onOpenTaskOutput,
  onRequestKill,
}: {
  workers: ClusterWorkerRegistration[] | null;
  activeWorkers: ClusterWorkerRegistration[];
  oldWorkers: ClusterWorkerRegistration[];
  onOpenTaskOutput: (taskId: string) => void;
  onRequestKill: (workerId: string) => void;
}) {
  if (!workers) {
    return <div className="text-sm text-zinc-500 dark:text-zinc-400">-</div>;
  }
  if (workers.length === 0) {
    return <div className="text-sm text-zinc-500 dark:text-zinc-400">No workers</div>;
  }
  return (
    <div className="flex flex-col gap-2">
      {activeWorkers.length > 0 && (
        <>
          <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 sticky top-0 z-10 bg-zinc-100/95 dark:bg-zinc-900/95 backdrop-blur-sm py-1">
            Active ({activeWorkers.length})
          </div>
          {activeWorkers.map((w) => (
            <WorkerBlock key={w.workerId} w={w} onOpenTaskOutput={onOpenTaskOutput} onRequestKill={onRequestKill} />
          ))}
        </>
      )}
      {oldWorkers.length > 0 && (
        <>
          <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 sticky top-0 z-10 bg-zinc-100/95 dark:bg-zinc-900/95 backdrop-blur-sm py-1">
            Exited ({oldWorkers.length})
          </div>
          {oldWorkers.map((w) => (
            <WorkerBlock key={w.workerId} w={w} onOpenTaskOutput={onOpenTaskOutput} onRequestKill={onRequestKill} />
          ))}
        </>
      )}
    </div>
  );
}
