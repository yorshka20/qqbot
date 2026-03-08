import { useState } from 'react';

interface RenameModalProps {
  open: boolean;
  path: string;
  currentName: string;
  onRename: (newName: string) => void;
  onCancel: () => void;
}

export function RenameModal({ open, path, currentName, onRename, onCancel }: RenameModalProps) {
  const [value, setValue] = useState(() => currentName);

  if (!open) {
    return null;
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed && trimmed !== currentName) {
      onRename(trimmed);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-title"
    >
      <div className="rounded-xl border border-zinc-200 bg-white shadow-xl max-w-md w-full p-5">
        <h2 id="rename-title" className="text-lg font-semibold text-zinc-900 mb-2">
          Rename
        </h2>
        <p className="text-zinc-600 text-sm mb-2 truncate" title={path}>
          <span className="font-mono text-zinc-800">{path}</span>
        </p>
        <form onSubmit={handleSubmit} className="mb-6">
          <label htmlFor="rename-input" className="block text-sm font-medium text-zinc-700 mb-1">
            New name
          </label>
          <input
            id="rename-input"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
            placeholder="Enter new file name"
          />
        </form>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg border border-zinc-300 text-zinc-700 hover:bg-zinc-50 font-medium text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              const trimmed = value.trim();
              if (trimmed && trimmed !== currentName) {
                onRename(trimmed);
              }
            }}
            disabled={!value.trim() || value.trim() === currentName}
            className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-900 disabled:opacity-50 disabled:pointer-events-none font-medium text-sm text-white"
          >
            Rename
          </button>
        </div>
      </div>
    </div>
  );
}
