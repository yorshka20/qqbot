interface PreviewPaneProps {
  selectedPath: string | null;
  selectedName: string | null;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.ogg', '.mov']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a']);

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

export function PreviewPane({ selectedPath, selectedName }: PreviewPaneProps) {
  if (!selectedPath || !selectedName) {
    return (
      <aside className="flex flex-col items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50/50 p-8 text-zinc-500 text-sm">
        Select a file to preview.
      </aside>
    );
  }

  const url = `/output/${selectedPath}`;
  const e = ext(selectedName);

  if (IMAGE_EXT.has(e)) {
    return (
      <aside className="rounded-lg border border-zinc-200 bg-white shadow-sm overflow-hidden flex flex-col">
        <div className="px-3 py-2 border-b border-zinc-100 text-sm font-medium text-zinc-700 truncate">
          {selectedName}
        </div>
        <div className="p-4 flex-1 min-h-0 flex items-center justify-center bg-zinc-100">
          <img src={url} alt={selectedName} className="max-w-full max-h-full object-contain" />
        </div>
      </aside>
    );
  }

  if (VIDEO_EXT.has(e)) {
    return (
      <aside className="rounded-lg border border-zinc-200 bg-white shadow-sm overflow-hidden flex flex-col">
        <div className="px-3 py-2 border-b border-zinc-100 text-sm font-medium text-zinc-700 truncate">
          {selectedName}
        </div>
        <div className="p-4 bg-zinc-100">
          {/* biome-ignore lint/a11y/useMediaCaption: internal preview tool, captions not applicable */}
          <video src={url} controls className="w-full rounded" />
        </div>
      </aside>
    );
  }

  if (AUDIO_EXT.has(e)) {
    return (
      <aside className="rounded-lg border border-zinc-200 bg-white shadow-sm overflow-hidden flex flex-col">
        <div className="px-3 py-2 border-b border-zinc-100 text-sm font-medium text-zinc-700 truncate">
          {selectedName}
        </div>
        <div className="p-4 bg-zinc-100">
          {/* biome-ignore lint/a11y/useMediaCaption: internal preview tool, captions not applicable */}
          <audio src={url} controls className="w-full" />
        </div>
      </aside>
    );
  }

  return (
    <aside className="rounded-lg border border-zinc-200 bg-white shadow-sm overflow-hidden flex flex-col">
      <div className="px-3 py-2 border-b border-zinc-100 text-sm font-medium text-zinc-700 truncate">
        {selectedName}
      </div>
      <div className="p-4 text-sm text-zinc-600">
        <p className="mb-2">No preview available.</p>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-800 font-medium"
        >
          Download file
        </a>
      </div>
    </aside>
  );
}
