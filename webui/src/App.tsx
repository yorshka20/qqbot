import { useCallback, useEffect, useState } from 'react'
import { deleteFile, listFiles, moveFile } from './api'
import type { FileItem } from './types'
import { Breadcrumb } from './components/Breadcrumb'
import { ConfirmDialog } from './components/ConfirmDialog'
import { FileList } from './components/FileList'
import { MoveModal } from './components/MoveModal'
import { PreviewPane } from './components/PreviewPane'

export default function App() {
  const [currentPath, setCurrentPath] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [items, setItems] = useState<FileItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [moveTarget, setMoveTarget] = useState<string | null>(null)

  const load = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      const data = await listFiles(path)
      setItems(data.items)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(currentPath)
  }, [currentPath, load])

  const handleOpenDir = useCallback((path: string) => {
    setCurrentPath(path)
    setSelectedPath(null)
    setSelectedName(null)
  }, [])

  const handleSelect = useCallback((item: FileItem) => {
    if (item.isDir) {
      return
    }
    setSelectedPath(item.path)
    setSelectedName(item.name)
  }, [])

  const handleDeleteClick = useCallback((path: string) => {
    setDeleteTarget(path)
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteTarget === null) {
      return
    }
    const path = deleteTarget
    setDeleteTarget(null)
    try {
      await deleteFile(path)
      setSelectedPath(null)
      setSelectedName(null)
      await load(currentPath)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }, [deleteTarget, currentPath, load])

  const handleMoveClick = useCallback((path: string) => {
    setMoveTarget(path)
  }, [])

  const handleMoveConfirm = useCallback(async (toPath: string) => {
    if (moveTarget === null) {
      return
    }
    const fromPath = moveTarget
    setMoveTarget(null)
    try {
      await moveFile(fromPath, toPath)
      setSelectedPath(null)
      setSelectedName(null)
      await load(currentPath)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Move failed')
    }
  }, [moveTarget, currentPath, load])

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900 flex flex-col">
      <header className="border-b border-zinc-200 bg-white shadow-sm shrink-0">
        <div className="px-4 py-3 flex items-center gap-4">
          <h1 className="text-lg font-semibold text-zinc-900 shrink-0">Output 文件管理</h1>
          <Breadcrumb path={currentPath} onNavigate={setCurrentPath} />
        </div>
      </header>

      <div className="flex-1 flex gap-4 p-4 min-h-0">
        <div className="flex-1 min-w-0 flex flex-col">
          <FileList
            items={items}
            selectedPath={selectedPath}
            onSelect={handleSelect}
            onOpenDir={handleOpenDir}
            onDelete={handleDeleteClick}
            onMove={handleMoveClick}
            loading={loading}
            error={error}
          />
        </div>
        <div className="w-96 shrink-0 flex flex-col min-h-0">
          <PreviewPane selectedPath={selectedPath} selectedName={selectedName} />
        </div>
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete file"
        message={deleteTarget ? `Delete "${deleteTarget}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
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
  )
}
