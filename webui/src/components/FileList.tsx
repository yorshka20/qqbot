import type { FileItem } from '../types'

interface FileListProps {
  items: FileItem[]
  selectedPath: string | null
  onSelect: (item: FileItem) => void
  onOpenDir: (path: string) => void
  onDelete: (path: string) => void
  onMove: (path: string) => void
  loading: boolean
  error: string | null
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatMtime(ms: number): string {
  return new Date(ms).toLocaleString()
}

export function FileList({
  items,
  selectedPath,
  onSelect,
  onOpenDir,
  onDelete,
  onMove,
  loading,
  error,
}: FileListProps) {
  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 text-sm">
        {error}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-zinc-500">
        Loading…
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-8 text-center text-zinc-500 text-sm">
        This folder is empty.
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50/80">
            <th className="text-left font-medium text-zinc-600 py-3 px-4 w-10" aria-label="Type" />
            <th className="text-left font-medium text-zinc-600 py-3 px-4">Name</th>
            <th className="text-left font-medium text-zinc-600 py-3 px-4 w-24">Size</th>
            <th className="text-left font-medium text-zinc-600 py-3 px-4 w-40">Modified</th>
            <th className="text-right font-medium text-zinc-600 py-3 px-4 w-32">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const isSelected = selectedPath === item.path
            return (
              <tr
                key={item.path}
                className={`border-b border-zinc-100 last:border-0 ${
                  isSelected ? 'bg-blue-50' : 'hover:bg-zinc-50'
                }`}
              >
                <td className="py-2 px-4">
                  {item.isDir ? (
                    <span className="text-amber-600" aria-hidden>📁</span>
                  ) : (
                    <span className="text-zinc-400" aria-hidden>📄</span>
                  )}
                </td>
                <td className="py-2 px-4">
                  {item.isDir ? (
                    <button
                      type="button"
                      onClick={() => onOpenDir(item.path)}
                      className="text-left font-medium text-blue-600 hover:text-blue-800 hover:underline"
                    >
                      {item.name}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSelect(item)}
                      className="text-left font-medium text-zinc-900 hover:text-blue-600 hover:underline"
                    >
                      {item.name}
                    </button>
                  )}
                </td>
                <td className="py-2 px-4 text-zinc-500">
                  {item.isDir ? '—' : (item.size != null ? formatSize(item.size) : '—')}
                </td>
                <td className="py-2 px-4 text-zinc-500">
                  {item.mtime != null ? formatMtime(item.mtime) : '—'}
                </td>
                <td className="py-2 px-4 text-right">
                  {!item.isDir && (
                    <>
                      <button
                        type="button"
                        onClick={() => onSelect(item)}
                        className="text-blue-600 hover:text-blue-800 mr-2 text-xs font-medium"
                      >
                        Preview
                      </button>
                      <button
                        type="button"
                        onClick={() => onMove(item.path)}
                        className="text-zinc-600 hover:text-zinc-800 mr-2 text-xs font-medium"
                      >
                        Move
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(item.path)}
                        className="text-red-600 hover:text-red-800 text-xs font-medium"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
