import { FileText, Folder, Music, Play } from 'lucide-react';
import type { FileItem } from '../types';
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT } from '../utils/fileType';

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

interface ResourceCardProps {
  item: FileItem;
  baseUrl: string;
  onOpenDir: (path: string) => void;
  onSelectFile: (item: FileItem) => void;
  onRename: (path: string) => void;
  onMove: (path: string) => void;
  onDelete: (path: string) => void;
}

export function ResourceCard({
  item,
  baseUrl,
  onOpenDir,
  onSelectFile,
  onRename,
  onMove,
  onDelete,
}: ResourceCardProps) {
  const url = `${baseUrl}/${item.path}`;
  const e = ext(item.name);

  const isImage = !item.isDir && IMAGE_EXT.has(e);
  const isVideo = !item.isDir && VIDEO_EXT.has(e);
  const isAudio = !item.isDir && AUDIO_EXT.has(e);

  const handleClick = () => {
    if (item.isDir) {
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

  return (
    <div className="resource-card group relative flex flex-col rounded-xl border border-zinc-200/80 bg-white shadow-sm overflow-hidden transition-all hover:shadow-md hover:border-zinc-300 focus-within:ring-2 focus-within:ring-blue-400 focus-within:border-blue-400 outline-none">
      <button
        type="button"
        className="absolute inset-0 w-full h-full z-0 cursor-pointer border-0 bg-transparent p-0 text-left"
        aria-label={item.isDir ? `Open folder ${item.name}` : `Preview ${item.name}`}
        onClick={handleClick}
      />
      {/* Preview area — fixed aspect ratio */}
      <div className="aspect-square w-full bg-zinc-100 flex items-center justify-center overflow-hidden shrink-0 relative z-10 pointer-events-none">
        {item.isDir ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-zinc-400">
            <Folder className="w-16 h-16" aria-hidden />
            <span className="text-xs font-medium text-zinc-500">Folder</span>
          </div>
        ) : isImage ? (
          <img src={url} alt={item.name} className="w-full h-full object-cover" loading="lazy" decoding="async" />
        ) : isVideo ? (
          <div className="relative w-full h-full flex items-center justify-center bg-zinc-200">
            <video
              src={url}
              className="w-full h-full object-contain"
              preload="metadata"
              muted
              playsInline
              onLoadedData={(ev) => {
                const v = ev.currentTarget;
                if (v.duration > 0) {
                  v.currentTime = Math.min(1, v.duration * 0.1);
                }
              }}
            />
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span
                className="w-12 h-12 rounded-full bg-black/50 flex items-center justify-center text-white"
                aria-hidden
              >
                <Play className="w-6 h-6 ml-0.5 fill-current" aria-hidden />
              </span>
            </div>
          </div>
        ) : isAudio ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-zinc-400">
            <Music className="w-14 h-14" aria-hidden />
            <span className="text-xs font-medium text-zinc-500">Audio</span>
          </div>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-zinc-400">
            <FileText className="w-14 h-14" aria-hidden />
            <span className="text-xs font-medium text-zinc-500">File</span>
          </div>
        )}
      </div>

      {/* Name + actions */}
      <div className="relative z-10 p-2.5 min-w-0 flex flex-col gap-1.5 bg-white">
        <p className="text-sm font-medium text-zinc-800 truncate px-0.5" title={item.name}>
          {item.name}
        </p>
        {!item.isDir && (
          <div className="flex items-center gap-1 flex-wrap opacity-70 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
            <button
              type="button"
              className="px-2 py-1 rounded text-xs font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
              title="Rename"
              onClick={(ev) => handleAction(ev, () => onRename(item.path))}
            >
              Rename
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded text-xs font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
              title="Move"
              onClick={(ev) => handleAction(ev, () => onMove(item.path))}
            >
              Move
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded text-xs font-medium text-red-600 hover:bg-red-50 hover:text-red-700"
              title="Delete"
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
