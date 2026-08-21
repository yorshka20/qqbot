import * as Dialog from '@radix-ui/react-dialog';
import { Skull } from 'lucide-react';

const COPY: Record<'worker' | 'task' | 'job', { title: string; body: React.ReactNode }> = {
  worker: {
    title: 'Kill worker?',
    body: 'This sends SIGKILL to the worker process and its current task will be marked as failed. This is NOT a graceful shutdown — in-flight work is lost.',
  },
  task: {
    title: 'Kill task?',
    body: 'This cancels the task and cascades to its child tasks (if any). Any worker currently running it will be terminated.',
  },
  job: {
    title: 'Kill job?',
    body: 'This cancels all live tasks belonging to this job. Workers currently running those tasks will be terminated.',
  },
};

export function KillConfirmDialog({
  kind,
  id,
  note,
  onCancel,
  onConfirm,
}: {
  kind: 'worker' | 'task' | 'job';
  id: string;
  /** Extra context appended below the base copy (e.g. orphan-worker warning). */
  note?: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const { title, body } = COPY[kind];
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
          <Dialog.Title className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">{title}</Dialog.Title>
          <div className="text-sm text-zinc-700 dark:text-zinc-300 mb-4">
            {body} <span className="font-mono">{id}</span>
            {note && <div className="mt-2">{note}</div>}
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
              Kill
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
