import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';

interface MoveModalProps {
  open: boolean;
  fromPath: string;
  currentPath: string;
  onMove: (toPath: string) => void;
  onCancel: () => void;
}

const defaultToPath = (currentPath: string, fileName: string) =>
  currentPath ? `${currentPath}/${fileName}` : fileName;

export function MoveModal({ open, fromPath, currentPath, onMove, onCancel }: MoveModalProps) {
  const fileName = fromPath.split('/').pop() ?? fromPath;
  // Parent uses key={moveTarget ?? 'closed'}, so we remount when opening; initial state is correct.
  const [toPath, setToPath] = useState(() => defaultToPath(currentPath, fileName));

  const handleConfirm = () => {
    const trimmed = toPath.trim();
    if (trimmed) {
      onMove(trimmed);
      onCancel();
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-zinc-200 bg-white p-5 shadow-xl">
          <Dialog.Title className="text-lg font-semibold text-zinc-900 mb-2">Move file</Dialog.Title>
          <Dialog.Description asChild>
            <p className="text-zinc-600 text-sm mb-2 truncate" title={fromPath}>
              From: <span className="font-mono text-zinc-800">{fromPath}</span>
            </p>
          </Dialog.Description>
          <div className="mb-6">
            <label htmlFor="move-dest" className="block text-sm font-medium text-zinc-700 mb-1">
              To path (relative to output)
            </label>
            <input
              id="move-dest"
              type="text"
              value={toPath}
              onChange={(e) => setToPath(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
              placeholder="e.g. downloads/newfolder/file.png"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                className="px-4 py-2 rounded-lg border border-zinc-300 text-zinc-700 hover:bg-zinc-50 font-medium text-sm"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!toPath.trim()}
              className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-900 disabled:opacity-50 disabled:pointer-events-none font-medium text-sm text-white"
            >
              Move
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
