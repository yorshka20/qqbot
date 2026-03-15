import { Check, FileText, Folder, ImageIcon, Music, Play } from 'lucide-react';

import { useLazyLoad } from '../hooks/useLazyLoad';
import type { FileItem } from '../types';
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT } from '../utils/fileType';

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function formatSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

type FileCategory = 'folder' | 'image' | 'video' | 'audio' | 'sticker' | 'other';

function getCategory(item: FileItem): FileCategory {
  if (item.isDir) return 'folder';
  const e = ext(item.name);
  if (IMAGE_EXT.has(e)) return item.path.toLowerCase().includes('sticker') ? 'sticker' : 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  return 'other';
}

const CATEGORY_BADGE: Record<FileCategory, { bg: string; label: string }> = {
  image: { bg: 'bg-sky-500', label: 'IMAGE' },
  video: { bg: 'bg-violet-500', label: 'VIDEO' },
  audio: { bg: 'bg-emerald-500', label: 'AUDIO' },
  sticker: { bg: 'bg-pink-500', label: 'STICKER' },
  folder: { bg: 'bg-amber-500', label: 'FOLDER' },
  other: { bg: 'bg-zinc-500', label: 'FILE' },
};

interface ResourceCardProps {
  item: FileItem;
  baseUrl: string;
  selected: boolean;
  selectMode: boolean;
  onOpenDir: (path: string) => void;
  onSelectFile: (item: FileItem) => void;
  onToggleSelect: (path: string) => void;
  onRename: (path: string) => void;
  onMove: (path: string) => void;
  onDelete: (path: string) => void;
}

export function ResourceCard({
  item,
  baseUrl,
  selected,
  selectMode,
  onOpenDir,
  onSelectFile,
  onToggleSelect,
  onRename,
  onMove,
  onDelete,
}: ResourceCardProps) {
  const url = `${baseUrl}/${item.path}`;
  const e = ext(item.name);

  const isImage = !item.isDir && IMAGE_EXT.has(e);
  const isVideo = !item.isDir && VIDEO_EXT.has(e);
  const isAudio = !item.isDir && AUDIO_EXT.has(e);
  const canSelect = !item.isDir;

  // Lazy load: only load media when card enters viewport (with 200px margin)
  const [lazyRef, isVisible] = useLazyLoad<HTMLDivElement>();
  const shouldLoadMedia = isVisible;

  const category = getCategory(item);
  const { bg: badgeBg, label: badgeLabel } = CATEGORY_BADGE[category];
  // Show file extension for non-folder, else generic label
  const typeLabel = !item.isDir && e ? e.slice(1).toUpperCase() : badgeLabel;
  const sizeStr = formatSize(item.size);

  const handleClick = () => {
    if (canSelect && selectMode) {
      onToggleSelect(item.path);
    } else if (item.isDir) {
      onOpenDir(item.path);
    } else {
      onSelectFile(item);
    }
  };

  const handleAction = (ev: React.MouseEvent, action: () => void) => {
    ev.preventDefault();
    ev.stopPropagation();
    action();
  };

  const handleCheckboxClick = (ev: React.MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (canSelect) onToggleSelect(item.path);
  };

  return (
    <div
      className={`resource-card group relative flex flex-col rounded-xl border shadow-sm overflow-hidden transition-all hover:shadow-md focus-within:ring-2 focus-within:ring-blue-400 focus-within:border-blue-400 outline-none ${
        selected
          ? 'border-blue-400 dark:border-blue-500 bg-blue-50 dark:bg-blue-950/40 shadow-md ring-2 ring-blue-300 dark:ring-blue-700'
          : 'border-zinc-200/80 dark:border-zinc-700/80 bg-white dark:bg-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-600'
      }`}
    >
      <button
        type="button"
        className="absolute inset-0 w-full h-full z-0 cursor-pointer border-0 bg-transparent p-0 text-left"
        aria-label={item.isDir ? `Open folder ${item.name}` : `Preview ${item.name}`}
        onClick={handleClick}
      />

      {/* Checkbox (files only) */}
      {canSelect && (
        <button
          type="button"
          onClick={handleCheckboxClick}
          aria-label={selected ? 'Deselect' : 'Select'}
          className={`absolute top-2 left-2 z-20 w-5 h-5 rounded flex items-center justify-center transition-all shadow-sm ${
            selected
              ? 'bg-blue-500 dark:bg-blue-400 text-white opacity-100'
              : selectMode
                ? 'bg-white/90 dark:bg-zinc-800/90 border border-zinc-300 dark:border-zinc-600 opacity-100'
                : 'bg-white/90 dark:bg-zinc-800/90 border border-zinc-300 dark:border-zinc-600 opacity-0 group-hover:opacity-100'
          }`}
        >
          {selected && <Check className="w-3 h-3" strokeWidth={3} />}
        </button>
      )}

      {/* Preview area */}
      <div
        ref={lazyRef}
        className={`aspect-square w-full flex items-center justify-center overflow-hidden shrink-0 relative z-10 pointer-events-none ${
          selected ? 'bg-blue-100 dark:bg-blue-900/30' : 'bg-zinc-100 dark:bg-zinc-700'
        }`}
      >
        {item.isDir ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-zinc-400 dark:text-zinc-500">
            <Folder className="w-16 h-16" aria-hidden />
          </div>
        ) : isImage ? (
          shouldLoadMedia ? (
            <img src={url} alt={item.name} className="w-full h-full object-cover" loading="lazy" decoding="async" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-zinc-300 dark:text-zinc-500">
              <ImageIcon className="w-14 h-14" aria-hidden />
            </div>
          )
        ) : isVideo ? (
          <div className="relative w-full h-full flex items-center justify-center bg-zinc-200 dark:bg-zinc-600">
            {shouldLoadMedia && (
              <video
                src={url}
                className="w-full h-full object-contain"
                preload="metadata"
                muted
                playsInline
                onLoadedData={(ev) => {
                  const v = ev.currentTarget;
                  if (v.duration > 0) v.currentTime = Math.min(1, v.duration * 0.1);
                }}
              />
            )}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span
                className="w-12 h-12 rounded-full bg-black/50 flex items-center justify-center text-white"
                aria-hidden
              >
                <Play className="w-6 h-6 ml-0.5 fill-current" />
              </span>
            </div>
          </div>
        ) : isAudio ? (
          <div className="w-full h-full flex items-center justify-center text-zinc-300 dark:text-zinc-500">
            <Music className="w-14 h-14" aria-hidden />
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-zinc-300 dark:text-zinc-500">
            <FileText className="w-14 h-14" aria-hidden />
          </div>
        )}

        {/* Badges: type (bottom-left) + size (bottom-right) */}
        <div className="absolute bottom-0 left-0 right-0 px-2 pb-2 flex items-end justify-between gap-1">
          <span
            className={`${badgeBg} text-white rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide leading-none shadow-sm`}
          >
            {typeLabel}
          </span>
          {sizeStr && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium leading-none bg-black/50 text-white/95 backdrop-blur-sm shadow-sm">
              {sizeStr}
            </span>
          )}
        </div>
      </div>

      {/* Name + actions */}
      <div
        className={`relative z-10 p-2.5 min-w-0 flex flex-col gap-1 ${
          selected ? 'bg-blue-50 dark:bg-blue-950/40' : 'bg-white dark:bg-zinc-800'
        }`}
      >
        <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate" title={item.name}>
          {item.name}
        </p>
        {!item.isDir && (
          <div className="flex items-center gap-1 flex-wrap opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
            <button
              type="button"
              className="px-2 py-1 rounded text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 hover:text-zinc-900 dark:hover:text-zinc-100"
              onClick={(ev) => handleAction(ev, () => onRename(item.path))}
            >
              Rename
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 hover:text-zinc-900 dark:hover:text-zinc-100"
              onClick={(ev) => handleAction(ev, () => onMove(item.path))}
            >
              Move
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50 hover:text-red-700 dark:hover:text-red-300"
              onClick={(ev) => handleAction(ev, () => onDelete(item.path))}
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
