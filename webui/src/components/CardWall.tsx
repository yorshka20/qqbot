import type { FileItem } from '../types'
import { ResourceCard } from './ResourceCard'

const OUTPUT_BASE = '/output'

interface CardWallProps {
  items: FileItem[]
  loading: boolean
  error: string | null
  onOpenDir: (path: string) => void
  onSelectFile: (item: FileItem) => void
  onRename: (path: string) => void
  onMove: (path: string) => void
  onDelete: (path: string) => void
}

export function CardWall({
  items,
  loading,
  error,
  onOpenDir,
  onSelectFile,
  onRename,
  onMove,
  onDelete,
}: CardWallProps) {
  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-800 text-sm">
        {error}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="flex flex-col items-center gap-3 text-zinc-500">
          <svg
            className="w-10 h-10 animate-spin text-zinc-400"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden
          >
            <title>Loading</title>
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span className="text-sm font-medium">Loading…</span>
        </div>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-zinc-50/80 p-12 text-center">
        <p className="text-zinc-500 text-sm mb-1">This folder is empty.</p>
        <p className="text-zinc-400 text-xs">Upload or create files in the output directory.</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
      {items.map((item) => (
        <ResourceCard
          key={item.path}
          item={item}
          baseUrl={OUTPUT_BASE}
          onOpenDir={onOpenDir}
          onSelectFile={onSelectFile}
          onRename={onRename}
          onMove={onMove}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}
