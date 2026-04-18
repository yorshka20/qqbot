import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';

interface BatchMoveModalProps {
  open: boolean;
  count: number;
  onMove: (destDir: string) => void;
  onCancel: () => void;
}

export function BatchMoveModal({ open, count, onMove, onCancel }: BatchMoveModalProps) {
  const [destDir, setDestDir] = useState('');

  const handleConfirm = () => {
    const trimmed = destDir.trim().replace(/\/$/, '');
    onMove(trimmed);
    onCancel();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-5 shadow-xl">
          <Dialog.Title className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
            Move {count} file{count !== 1 ? 's' : ''}
          </Dialog.Title>
          <Dialog.Description className="text-zinc-600 dark:text-zinc-400 text-sm mb-4">
            Enter destination directory (relative to output). Files keep their names.
          </Dialog.Description>
          <div className="mb-6">
            <label htmlFor="batch-move-dest" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Destination directory
            </label>
            <input
              id="batch-move-dest"
              type="text"
              value={destDir}
              onChange={(e) => setDestDir(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && destDir.trim()) handleConfirm(); }}
              autoFocus
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
              placeholder="e.g. archive/2024  (empty = root)"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                className="px-4 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 font-medium text-sm"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={handleConfirm}
              className="px-4 py-2 rounded-lg bg-zinc-800 dark:bg-zinc-200 hover:bg-zinc-900 dark:hover:bg-white text-white dark:text-zinc-900 font-medium text-sm"
            >
              Move
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
