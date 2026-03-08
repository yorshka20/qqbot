import { useCallback, useEffect, useState } from 'react';
import { deleteFile, listFiles, moveFile, renameFile } from './api';
import { Breadcrumb } from './components/Breadcrumb';
import { CardWall } from './components/CardWall';
import { ConfirmDialog } from './components/ConfirmDialog';
import { MoveModal } from './components/MoveModal';
import { PreviewModal } from './components/PreviewModal';
import { RenameModal } from './components/RenameModal';
import type { FileItem } from './types';

export default function App() {
  const [currentPath, setCurrentPath] = useState('');
  const [previewFile, setPreviewFile] = useState<{ path: string; name: string } | null>(null);
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900 flex flex-col">
      <header className="border-b border-zinc-200 bg-white shrink-0">
        <div className="px-4 py-3 flex items-center gap-4 flex-wrap">
          <h1 className="text-lg font-semibold text-zinc-900 shrink-0">Output 资源</h1>
          <nav className="min-w-0 flex-1">
            <Breadcrumb path={currentPath} onNavigate={setCurrentPath} />
          </nav>
        </div>
      </header>

      <main className="flex-1 min-w-0 overflow-auto p-4">
        <CardWall
          items={items}
          loading={loading}
          error={error}
          onOpenDir={handleOpenDir}
          onSelectFile={handleSelectFile}
          onRename={handleRenameClick}
          onMove={handleMoveClick}
          onDelete={handleDeleteClick}
        />
      </main>

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
