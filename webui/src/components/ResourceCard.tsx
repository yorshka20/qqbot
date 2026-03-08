import type { FileItem } from '../types';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.ogg', '.mov']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a']);

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
            <svg className="w-16 h-16" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
              <title>Folder</title>
              <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
            </svg>
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
                <svg className="w-6 h-6 ml-0.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <title>Play</title>
                  <path d="M8 5v14l11-7z" />
                </svg>
              </span>
            </div>
          </div>
        ) : isAudio ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-zinc-400">
            <svg className="w-14 h-14" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
              <title>Audio file</title>
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
            </svg>
            <span className="text-xs font-medium text-zinc-500">Audio</span>
          </div>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-zinc-400">
            <svg className="w-14 h-14" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
              <title>File</title>
              <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />
            </svg>
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
