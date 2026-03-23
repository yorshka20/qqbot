import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getOutputBase } from '../config';
import type { FileItem } from '../types';
import { ResourceCard } from './ResourceCard';

interface CardWallProps {
  items: FileItem[];
  loading: boolean;
  error: string | null;
  selectedPaths: Set<string>;
  selectMode: boolean;
  onOpenDir: (path: string) => void;
  onSelectFile: (item: FileItem) => void;
  onToggleSelect: (path: string) => void;
  onRename: (path: string) => void;
  onMove: (path: string) => void;
  onDelete: (path: string) => void;
  /** Shown when items.length === 0 (e.g. "No items match the current filter."). */
  emptyMessage?: string;
}

const DEFAULT_EMPTY_MESSAGE = 'This folder is empty.';

/** Number of items to render per batch */
const BATCH_SIZE = 60;

export function CardWall({
  items,
  loading,
  error,
  selectedPaths,
  selectMode,
  onOpenDir,
  onSelectFile,
  onToggleSelect,
  onRename,
  onMove,
  onDelete,
  emptyMessage = DEFAULT_EMPTY_MESSAGE,
}: CardWallProps) {
  // Progressive rendering: start with first batch, load more as user scrolls.
  // Parent must pass a `key` to reset visibleCount when items change (e.g. navigation, filter).
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // IntersectionObserver on sentinel to load more items
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((prev) => Math.min(prev + BATCH_SIZE, items.length));
        }
      },
      { rootMargin: '400px' },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [items.length]);

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-6 text-red-800 dark:text-red-300 text-sm">
        {error}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="flex flex-col items-center gap-3 text-zinc-500 dark:text-zinc-400">
          <Loader2 className="w-10 h-10 animate-spin text-zinc-400 dark:text-zinc-500" aria-hidden />
          <span className="text-sm font-medium">Loading…</span>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/80 dark:bg-zinc-800/50 p-12 text-center">
        <p className="text-zinc-500 dark:text-zinc-400 text-sm mb-1">{emptyMessage}</p>
        <p className="text-zinc-400 dark:text-zinc-500 text-xs">Upload or create files in the output directory.</p>
      </div>
    );
  }

  const baseUrl = getOutputBase();
  const visibleItems = items.length <= BATCH_SIZE ? items : items.slice(0, visibleCount);
  const hasMore = visibleCount < items.length;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {visibleItems.map((item) => (
          <ResourceCard
            key={item.path}
            item={item}
            baseUrl={baseUrl}
            selected={selectedPaths.has(item.path)}
            selectMode={selectMode}
            onOpenDir={onOpenDir}
            onSelectFile={onSelectFile}
            onToggleSelect={onToggleSelect}
            onRename={onRename}
            onMove={onMove}
            onDelete={onDelete}
          />
        ))}
      </div>
      {/* Sentinel element triggers loading more items when scrolled into view */}
      {hasMore && (
        <div ref={sentinelRef} className="flex items-center justify-center py-6">
          <span className="text-xs text-zinc-400 dark:text-zinc-500">
            Showing {visibleCount} / {items.length}…
          </span>
        </div>
      )}
    </>
  );
}
