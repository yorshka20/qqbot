import { Pause, Play, Power, Square } from 'lucide-react';

export type ClusterLifecycleAction = 'start' | 'stop' | 'pause' | 'resume';

export function LifecycleControls({
  started,
  running,
  onAction,
}: {
  started: boolean | null;
  running: boolean;
  onAction: (action: ClusterLifecycleAction) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => onAction('start')}
        className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 disabled:opacity-40 transition-colors flex items-center gap-1.5"
        disabled={started === true}
      >
        <Power className="w-3.5 h-3.5" />
        Start
      </button>
      <button
        type="button"
        onClick={() => onAction('stop')}
        className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-40 transition-colors flex items-center gap-1.5"
        disabled={started === false}
      >
        <Square className="w-3.5 h-3.5" />
        Stop
      </button>
      <button
        type="button"
        onClick={() => onAction('pause')}
        className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 disabled:opacity-40 transition-colors flex items-center gap-1.5"
        disabled={!running}
      >
        <Pause className="w-3.5 h-3.5" />
        Pause
      </button>
      <button
        type="button"
        onClick={() => onAction('resume')}
        className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 disabled:opacity-40 transition-colors flex items-center gap-1.5"
        disabled={!running}
      >
        <Play className="w-3.5 h-3.5" />
        Resume
      </button>
    </div>
  );
}
