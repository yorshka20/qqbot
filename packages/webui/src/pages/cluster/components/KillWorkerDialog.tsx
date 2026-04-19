import * as Dialog from '@radix-ui/react-dialog';
import { Skull } from 'lucide-react';

export function KillWorkerDialog({
  workerId,
  isOrphan = false,
  onCancel,
  onConfirm,
}: {
  workerId: string;
  /** True when the worker has no live process in the pool (stuck registration). */
  isOrphan?: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Dialog.Root
      open={true}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(90vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white dark:bg-zinc-800 shadow-2xl p-5 focus:outline-none">
          <Dialog.Title className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
            {isOrphan ? 'Mark worker exited?' : 'Kill worker?'}
          </Dialog.Title>
          <div className="text-sm text-zinc-700 dark:text-zinc-300 mb-4">
            {isOrphan ? (
              <>
                No live process found for <span className="font-mono">{workerId}</span>. This marks the orphan
                registration as exited so the UI reflects reality.
              </>
            ) : (
              <>
                This sends SIGKILL to <span className="font-mono">{workerId}</span> and its current task will be marked
                as failed. This is NOT a graceful shutdown — in-flight work is lost.
              </>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void onConfirm()}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 flex items-center gap-2"
            >
              <Skull className="w-4 h-4" />
              {isOrphan ? 'Mark exited' : 'Kill'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
