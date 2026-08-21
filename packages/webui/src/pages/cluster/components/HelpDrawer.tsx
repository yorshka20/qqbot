import { HelpCircle, X } from 'lucide-react';
import { useEffect } from 'react';

import type { ClusterHelpRequest } from '../../../types';
import { HelpRequestRow } from './HelpRequestRow';

/**
 * Right-side drawer for pending worker help requests. No backdrop on purpose:
 * answering a request usually means cross-checking jobs/workers on the page
 * behind it, so the rest of the UI stays interactive while the drawer is open.
 */
export function HelpDrawer({
  open,
  help,
  onClose,
  onAnswered,
}: {
  open: boolean;
  help: ClusterHelpRequest[] | null;
  onClose: () => void;
  onAnswered: () => void;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-[min(28rem,100vw)] bg-white dark:bg-zinc-900 border-l border-zinc-200 dark:border-zinc-700 shadow-2xl flex flex-col">
      <div className="shrink-0 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-2">
        <HelpCircle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Help requests</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">({help?.length ?? 0})</div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
          aria-label="Close help requests"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 flex flex-col gap-2 [&>*]:shrink-0">
        {!help || help.length === 0 ? (
          <div className="text-sm text-zinc-500 dark:text-zinc-400 py-8 text-center">No pending requests</div>
        ) : (
          help.map((h) => <HelpRequestRow key={h.id} request={h} onAnswered={onAnswered} />)
        )}
      </div>
    </div>
  );
}
