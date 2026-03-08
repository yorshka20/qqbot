/**
 * Full-screen preview modal: click card to open, click outside to close.
 * Uses Radix Dialog; renders image/video/audio enlarged, other files show download link.
 */

import * as Dialog from '@radix-ui/react-dialog';
import { IMAGE_EXT, VIDEO_EXT, AUDIO_EXT } from '../utils/fileType';

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

interface PreviewModalProps {
  path: string;
  name: string;
  onClose: () => void;
}

export function PreviewModal({ path, name, onClose }: PreviewModalProps) {
  const url = `/output/${path}`;
  const e = ext(name);

  return (
    <Dialog.Root open={true} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl bg-white shadow-2xl flex flex-col focus:outline-none">
          <Dialog.Title className="sr-only">Preview: {name}</Dialog.Title>
          <div className="shrink-0 px-4 py-2 border-b border-zinc-200 flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-zinc-700 truncate min-w-0">{name}</span>
            <span className="text-xs text-zinc-400 shrink-0">Click outside to close</span>
          </div>
          <div className="flex-1 min-h-0 p-6 flex items-center justify-center bg-zinc-100">
            {IMAGE_EXT.has(e) && <img src={url} alt={name} className="max-w-full max-h-[75vh] object-contain" />}
            {VIDEO_EXT.has(e) && (
              <video src={url} controls className="max-w-full max-h-[75vh] rounded">
                <track kind="captions" />
              </video>
            )}
            {AUDIO_EXT.has(e) && (
              <div className="flex flex-col items-center gap-4">
                <audio src={url} controls className="w-full max-w-md">
                  <track kind="captions" />
                </audio>
                <p className="text-sm text-zinc-500">{name}</p>
              </div>
            )}
            {!IMAGE_EXT.has(e) && !VIDEO_EXT.has(e) && !AUDIO_EXT.has(e) && (
              <div className="text-center text-zinc-600">
                <p className="mb-3 text-sm">No preview available.</p>
                <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 font-medium">
                  Download file
                </a>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
