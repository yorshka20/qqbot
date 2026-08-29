import { FileText, Folder, Loader2 } from 'lucide-react';

import type { FileItem } from '../../../types';
import type { SelectedDoc } from '../utils';

export function DocsFileList({
  loading,
  error,
  rootExists,
  items,
  selectedPath,
  onOpenDir,
  onSelectFile,
}: {
  loading: boolean;
  error: string | null;
  rootExists: boolean;
  items: FileItem[];
  selectedPath: string | null;
  onOpenDir: (path: string) => void;
  onSelectFile: (file: SelectedDoc) => void;
}) {
  if (loading) {
    return (
      <div className="flex justify-center py-8 text-zinc-500">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-600 dark:text-red-400 px-2">{error}</p>;
  }

  if (!rootExists) {
    return <p className="text-sm text-zinc-500 px-2">该路径在磁盘上不存在。</p>;
  }

  if (items.length === 0) {
    return <p className="text-sm text-zinc-500 px-2">空目录</p>;
  }

  return (
    <ul className="space-y-0.5">
      {items.map((it) => (
        <li key={it.path}>
          {it.isDir ? (
            <button
              type="button"
              className="w-full flex items-center gap-2 text-left rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-700"
              onClick={() => onOpenDir(it.path)}
            >
              <Folder className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-500" />
              <span className="truncate">{it.name}</span>
            </button>
          ) : (
            <button
              type="button"
              className={`w-full flex items-center gap-2 text-left rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-700 ${
                selectedPath === it.path ? 'bg-zinc-100 dark:bg-zinc-700' : ''
              }`}
              onClick={() => onSelectFile({ path: it.path, name: it.name })}
            >
              <FileText className="w-4 h-4 shrink-0 text-zinc-400" />
              <span className="truncate">{it.name}</span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
