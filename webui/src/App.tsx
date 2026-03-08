import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { deleteFile, listFiles, moveFile, renameFile } from './api';
import { Breadcrumb } from './components/Breadcrumb';
import { CardWall } from './components/CardWall';
import { ConfirmDialog } from './components/ConfirmDialog';
import { MoveModal } from './components/MoveModal';
import { PreviewModal } from './components/PreviewModal';
import { RenameModal } from './components/RenameModal';
import { Sidebar } from './components/Sidebar';
import type { FileItem } from './types';
import { type FilterType, filterByType, type GroupBy, groupItems, type SortOrder, sortByDate } from './utils/fileType';

export default function App() {
  const [currentPath, setCurrentPath] = useState('');
  const [previewFile, setPreviewFile] = useState<{ path: string; name: string } | null>(null);
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [typeFilter, setTypeFilter] = useState<FilterType>('all');
  const [sortOrder, setSortOrder] = useState<SortOrder>('dateDesc');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ path: string; name: string } | null>(null);

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await listFiles(path);
      setItems(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(currentPath);
  }, [currentPath, load]);

  const handleOpenDir = useCallback((path: string) => {
    setCurrentPath(path);
    setPreviewFile(null);
  }, []);

  const handleSelectFile = useCallback((item: FileItem) => {
    setPreviewFile({ path: item.path, name: item.name });
  }, []);

  const handleDeleteClick = useCallback((path: string) => {
    setDeleteTarget(path);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteTarget === null) {
      return;
    }
    const path = deleteTarget;
    setDeleteTarget(null);
    try {
      await deleteFile(path);
      if (previewFile?.path === path) {
        setPreviewFile(null);
      }
      await load(currentPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }, [deleteTarget, previewFile?.path, currentPath, load]);

  const handleMoveClick = useCallback((path: string) => {
    setMoveTarget(path);
  }, []);

  const handleMoveConfirm = useCallback(
    async (toPath: string) => {
      if (moveTarget === null) {
        return;
      }
      const fromPath = moveTarget;
      setMoveTarget(null);
      try {
        await moveFile(fromPath, toPath);
        if (previewFile?.path === fromPath) {
          setPreviewFile({ path: toPath, name: toPath.split('/').pop() ?? '' });
        }
        await load(currentPath);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Move failed');
      }
    },
    [moveTarget, previewFile?.path, currentPath, load],
  );

  const handleRenameClick = useCallback(
    (path: string) => {
      const item = items.find((i) => i.path === path);
      if (item) {
        setRenameTarget({ path: item.path, name: item.name });
      }
    },
    [items],
  );

  const handleRenameConfirm = useCallback(
    async (newName: string) => {
      if (renameTarget === null) {
        return;
      }
      const { path } = renameTarget;
      setRenameTarget(null);
      try {
        await renameFile(path, newName);
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const newPath = dir ? `${dir}/${newName}` : newName;
        if (previewFile?.path === path) {
          setPreviewFile({ path: newPath, name: newName });
        }
        await load(currentPath);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Rename failed');
      }
    },
    [renameTarget, previewFile?.path, currentPath, load],
  );

  const groupedItems = useMemo(() => {
    const filtered = filterByType(items, typeFilter);
    const sorted = sortByDate(filtered, sortOrder);
    return groupItems(sorted, groupBy);
  }, [items, typeFilter, sortOrder, groupBy]);

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900 flex flex-col">
      <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white shrink-0">
        <div className="px-4 py-3 flex items-center gap-4 flex-wrap">
          <h1 className="text-lg font-semibold text-zinc-900 shrink-0">Output 资源</h1>
          <nav className="min-w-0 flex-1">
            <Breadcrumb path={currentPath} onNavigate={setCurrentPath} />
          </nav>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <Sidebar
          typeFilter={typeFilter}
          sortOrder={sortOrder}
          groupBy={groupBy}
          onTypeFilterChange={setTypeFilter}
          onSortOrderChange={setSortOrder}
          onGroupByChange={setGroupBy}
        />
        <main className="flex-1 min-w-0 overflow-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-24">
              <div className="flex flex-col items-center gap-3 text-zinc-500">
                <Loader2 className="w-10 h-10 animate-spin text-zinc-400" aria-hidden />
                <span className="text-sm font-medium">Loading…</span>
              </div>
            </div>
          ) : error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-800 text-sm">{error}</div>
          ) : groupedItems.length === 1 && !groupedItems[0].label ? (
            <CardWall
              items={groupedItems[0].items}
              loading={false}
              error={null}
              emptyMessage="No items match the current filter."
              onOpenDir={handleOpenDir}
              onSelectFile={handleSelectFile}
              onRename={handleRenameClick}
              onMove={handleMoveClick}
              onDelete={handleDeleteClick}
            />
          ) : (
            <div className="flex flex-col gap-8">
              {groupedItems.map((group) => (
                <section key={group.label || 'all'}>
                  {group.label ? (
                    <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-3">{group.label}</h2>
                  ) : null}
                  <CardWall
                    items={group.items}
                    loading={false}
                    error={null}
                    onOpenDir={handleOpenDir}
                    onSelectFile={handleSelectFile}
                    onRename={handleRenameClick}
                    onMove={handleMoveClick}
                    onDelete={handleDeleteClick}
                  />
                </section>
              ))}
            </div>
          )}
        </main>
      </div>

      {previewFile && (
        <PreviewModal path={previewFile.path} name={previewFile.name} onClose={() => setPreviewFile(null)} />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除确认"
        message={deleteTarget ? `确定要删除 "${deleteTarget}" 吗？此操作无法撤销。` : ''}
        confirmLabel="删除"
        danger
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />

      <RenameModal
        key={renameTarget?.path ?? 'closed'}
        open={renameTarget !== null}
        path={renameTarget?.path ?? ''}
        currentName={renameTarget?.name ?? ''}
        onRename={handleRenameConfirm}
        onCancel={() => setRenameTarget(null)}
      />

      <MoveModal
        key={moveTarget ?? 'closed'}
        open={moveTarget !== null}
        fromPath={moveTarget ?? ''}
        currentPath={currentPath}
        onMove={handleMoveConfirm}
        onCancel={() => setMoveTarget(null)}
      />
    </div>
  );
}
