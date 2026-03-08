import { useState } from "react";

interface MoveModalProps {
  open: boolean;
  fromPath: string;
  currentPath: string;
  onMove: (toPath: string) => void;
  onCancel: () => void;
}

const defaultToPath = (currentPath: string, fileName: string) =>
  currentPath ? `${currentPath}/${fileName}` : fileName;

export function MoveModal({
  open,
  fromPath,
  currentPath,
  onMove,
  onCancel,
}: MoveModalProps) {
  const fileName = fromPath.split("/").pop() ?? fromPath;
  const [toPath, setToPath] = useState(() =>
    defaultToPath(currentPath, fileName),
  );

  if (!open) {
    return null;
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = toPath.trim();
    if (trimmed) {
      onMove(trimmed);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="move-title"
    >
      <div className="rounded-lg border border-zinc-200 bg-white shadow-xl max-w-md w-full p-5">
        <h2
          id="move-title"
          className="text-lg font-semibold text-zinc-900 mb-2"
        >
          Move file
        </h2>
        <p className="text-zinc-600 text-sm mb-2 truncate" title={fromPath}>
          From: <span className="font-mono text-zinc-800">{fromPath}</span>
        </p>
        <form onSubmit={handleSubmit} className="mb-6">
          <label
            htmlFor="move-dest"
            className="block text-sm font-medium text-zinc-700 mb-1"
          >
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
            onClick={() => toPath.trim() && onMove(toPath.trim())}
            disabled={!toPath.trim()}
            className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-900 disabled:opacity-50 disabled:pointer-events-none font-medium text-sm text-white"
          >
            Move
          </button>
        </div>
      </div>
    </div>
  );
}
