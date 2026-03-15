/**
 * Files Page - Output resource management.
 * Browse, preview, rename, move, and delete files in the output directory.
 */

import { FolderInput, Loader2, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { deleteFile, listFiles, moveFile, renameFile } from '../api'
import { BatchMoveModal } from '../components/BatchMoveModal'
import { Breadcrumb } from '../components/Breadcrumb'
import { CardWall } from '../components/CardWall'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { MoveModal } from '../components/MoveModal'
import { PreviewModal } from '../components/PreviewModal'
import { RenameModal } from '../components/RenameModal'
import { Sidebar } from '../components/Sidebar'
import type { FileItem } from '../types'
import { type FilterType, filterByType, type GroupBy, groupItems, type SortOrder, sortItems } from '../utils/fileType'

export function FilesPage() {
  const [currentPath, setCurrentPath] = useState('')
  const [previewFile, setPreviewFile] = useState<{ path: string; name: string } | null>(null)
  const [items, setItems] = useState<FileItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [typeFilter, setTypeFilter] = useState<FilterType>('all')
  const [sortOrder, setSortOrder] = useState<SortOrder>('dateDesc')
  const [groupBy, setGroupBy] = useState<GroupBy>('none')

  // Multi-select
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const selectMode = selectedPaths.size > 0

  // Modal states
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [moveTarget, setMoveTarget] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ path: string; name: string } | null>(null)
  const [batchDeletePending, setBatchDeletePending] = useState(false)
  const [batchMovePending, setBatchMovePending] = useState(false)

  // ──────────────────────────────────────────────────
  // Data loading
  // ──────────────────────────────────────────────────

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

  // ──────────────────────────────────────────────────
  // Navigation handlers
  // ──────────────────────────────────────────────────

  const handleNavigate = useCallback((path: string) => {
    setCurrentPath(path)
    setTypeFilter('all')
    setSelectedPaths(new Set())
    setPreviewFile(null)
  }, [])

  const handleOpenDir = useCallback((path: string) => {
    setCurrentPath(path)
    setSelectedPaths(new Set())
    setPreviewFile(null)
  }, [])

  const handleSelectFile = useCallback((item: FileItem) => {
    setPreviewFile({ path: item.path, name: item.name })
  }, [])

  // ──────────────────────────────────────────────────
  // Single item operations
  // ──────────────────────────────────────────────────

  const handleDeleteClick = useCallback((path: string) => {
    setDeleteTarget(path)
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteTarget === null) return
    const path = deleteTarget
    setDeleteTarget(null)
    try {
      await deleteFile(path)
      if (previewFile?.path === path) setPreviewFile(null)
      await load(currentPath)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }, [deleteTarget, previewFile?.path, currentPath, load])

  const handleMoveClick = useCallback((path: string) => {
    setMoveTarget(path)
  }, [])

  const handleMoveConfirm = useCallback(
    async (toPath: string) => {
      if (moveTarget === null) return
      const fromPath = moveTarget
      setMoveTarget(null)
      try {
        await moveFile(fromPath, toPath)
        if (previewFile?.path === fromPath) {
          setPreviewFile({ path: toPath, name: toPath.split('/').pop() ?? '' })
        }
        await load(currentPath)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Move failed')
      }
    },
    [moveTarget, previewFile?.path, currentPath, load],
  )

  const handleRenameClick = useCallback(
    (path: string) => {
      const item = items.find((i) => i.path === path)
      if (item) setRenameTarget({ path: item.path, name: item.name })
    },
    [items],
  )

  const handleRenameConfirm = useCallback(
    async (newName: string) => {
      if (renameTarget === null) return
      const { path } = renameTarget
      setRenameTarget(null)
      try {
        await renameFile(path, newName)
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
        const newPath = dir ? `${dir}/${newName}` : newName
        if (previewFile?.path === path) setPreviewFile({ path: newPath, name: newName })
        await load(currentPath)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Rename failed')
      }
    },
    [renameTarget, previewFile?.path, currentPath, load],
  )

  // ──────────────────────────────────────────────────
  // Multi-select operations
  // ──────────────────────────────────────────────────

  const handleToggleSelect = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleSelectAll = useCallback(() => {
    const allPaths = items.filter((i) => !i.isDir).map((i) => i.path)
    setSelectedPaths(new Set(allPaths))
  }, [items])

  const handleClearSelection = useCallback(() => setSelectedPaths(new Set()), [])

  const handleBatchDeleteConfirm = useCallback(async () => {
    const paths = [...selectedPaths]
    setBatchDeletePending(false)
    setSelectedPaths(new Set())
    try {
      await Promise.all(paths.map((p) => deleteFile(p)))
      await load(currentPath)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }, [selectedPaths, currentPath, load])

  const handleBatchMoveConfirm = useCallback(
    async (destDir: string) => {
      const paths = [...selectedPaths]
      setSelectedPaths(new Set())
      try {
        await Promise.all(
          paths.map((p) => {
            const fileName = p.split('/').pop() ?? p
            const toPath = destDir ? `${destDir}/${fileName}` : fileName
            return moveFile(p, toPath)
          }),
        )
        await load(currentPath)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Move failed')
      }
    },
    [selectedPaths, currentPath, load],
  )

  // ──────────────────────────────────────────────────
  // Computed values
  // ──────────────────────────────────────────────────

  const groupedItems = useMemo(() => {
    const filtered = filterByType(items, typeFilter)
    const sorted = sortItems(filtered, sortOrder)
    return groupItems(sorted, groupBy)
  }, [items, typeFilter, sortOrder, groupBy])

  // ──────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────

  return (
    <>
      {/* Subheader with breadcrumb */}
      <div className="shrink-0 px-4 py-2 bg-zinc-50 dark:bg-zinc-800/50 border-b border-zinc-200 dark:border-zinc-700">
        <Breadcrumb path={currentPath} onNavigate={handleNavigate} />
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden min-w-0">
        <Sidebar
          typeFilter={typeFilter}
          sortOrder={sortOrder}
          groupBy={groupBy}
          onTypeFilterChange={setTypeFilter}
          onSortOrderChange={setSortOrder}
          onGroupByChange={setGroupBy}
        />
        <main className="flex-1 min-w-0 min-h-0 overflow-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-24">
              <div className="flex flex-col items-center gap-3 text-zinc-500 dark:text-zinc-400">
                <Loader2 className="w-10 h-10 animate-spin text-zinc-400 dark:text-zinc-500" aria-hidden />
                <span className="text-sm font-medium">Loading…</span>
              </div>
            </div>
          ) : error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-950/40 dark:border-red-900 p-6 text-red-800 dark:text-red-300 text-sm">
              {error}
            </div>
          ) : groupedItems.length === 1 && !groupedItems[0].label ? (
            <CardWall
              items={groupedItems[0].items}
              loading={false}
              error={null}
              emptyMessage="No items match the current filter."
              selectedPaths={selectedPaths}
              selectMode={selectMode}
              onOpenDir={handleOpenDir}
              onSelectFile={handleSelectFile}
              onToggleSelect={handleToggleSelect}
              onRename={handleRenameClick}
              onMove={handleMoveClick}
              onDelete={handleDeleteClick}
            />
          ) : (
            <div className="flex flex-col gap-8">
              {groupedItems.map((group) => (
                <section key={group.label || 'all'}>
                  {group.label ? (
                    <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-3">
                      {group.label}
                    </h2>
                  ) : null}
                  <CardWall
                    items={group.items}
                    loading={false}
                    error={null}
                    selectedPaths={selectedPaths}
                    selectMode={selectMode}
                    onOpenDir={handleOpenDir}
                    onSelectFile={handleSelectFile}
                    onToggleSelect={handleToggleSelect}
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

      {/* Multi-select toolbar */}
      {selectMode && (
        <div className="shrink-0 border-t border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-4 py-3 flex items-center gap-3 shadow-lg z-30">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{selectedPaths.size} selected</span>
          <button
            type="button"
            onClick={handleSelectAll}
            className="text-xs px-2 py-1 rounded border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-700"
          >
            Select all files
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setBatchMovePending(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-zinc-100 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-600"
          >
            <FolderInput className="w-4 h-4" />
            Move to…
          </button>
          <button
            type="button"
            onClick={() => setBatchDeletePending(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50"
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </button>
          <button
            type="button"
            onClick={handleClearSelection}
            className="p-1.5 rounded-lg text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700"
            title="Clear selection"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Modals */}
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

      <ConfirmDialog
        open={batchDeletePending}
        title="批量删除确认"
        message={`确定要删除选中的 ${selectedPaths.size} 个文件吗？此操作无法撤销。`}
        confirmLabel="删除"
        danger
        onConfirm={handleBatchDeleteConfirm}
        onCancel={() => setBatchDeletePending(false)}
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

      <BatchMoveModal
        open={batchMovePending}
        count={selectedPaths.size}
        onMove={handleBatchMoveConfirm}
        onCancel={() => setBatchMovePending(false)}
      />
    </>
  )
}
