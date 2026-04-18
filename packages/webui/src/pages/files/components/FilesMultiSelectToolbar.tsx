import { FolderInput, Trash2, X } from 'lucide-react';

export function FilesMultiSelectToolbar({
  selectedCount,
  onSelectAll,
  onBatchMove,
  onBatchDelete,
  onClearSelection,
}: {
  selectedCount: number;
  onSelectAll: () => void;
  onBatchMove: () => void;
  onBatchDelete: () => void;
  onClearSelection: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-4 py-3 flex items-center gap-3 shadow-lg z-30">
      <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{selectedCount} selected</span>
      <button
        type="button"
        onClick={onSelectAll}
        className="text-xs px-2 py-1 rounded border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-700"
      >
        Select all files
      </button>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onBatchMove}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-zinc-100 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-600"
      >
        <FolderInput className="w-4 h-4" />
        Move to…
      </button>
      <button
        type="button"
        onClick={onBatchDelete}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50"
      >
        <Trash2 className="w-4 h-4" />
        Delete
      </button>
      <button
        type="button"
        onClick={onClearSelection}
        className="p-1.5 rounded-lg text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700"
        title="Clear selection"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
