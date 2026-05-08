/**
 * Modal showing the full content of a memory fact when a row is clicked.
 * Uses Radix Dialog; closes on outside click / Esc.
 */

import * as Dialog from '@radix-ui/react-dialog';
import { Copy, X } from 'lucide-react';
import { useState } from 'react';
import type { MemoryFactEntry } from '../../../types';
import { formatMemoryDate } from '../utils';

interface MemoryFactModalProps {
  fact: MemoryFactEntry;
  onClose: () => void;
}

export function MemoryFactModal({ fact, onClose }: MemoryFactModalProps) {
  const [copied, setCopied] = useState(false);
  const content = fact.content?.trim() ?? '';
  const isEmpty = content.length === 0;

  const handleCopy = async () => {
    if (isEmpty) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore clipboard failures (browser may block in non-secure contexts)
    }
  };

  return (
    <Dialog.Root
      open={true}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(90vw,640px)] max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl bg-white dark:bg-zinc-800 shadow-2xl flex flex-col focus:outline-none">
          <div className="shrink-0 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-sm font-semibold text-zinc-700 dark:text-zinc-200 truncate font-mono">
                {fact.scope}
              </Dialog.Title>
              <p className="text-xs text-zinc-400 mt-0.5 font-mono truncate">{fact.factHash}</p>
            </div>
            <Dialog.Close
              className="p-1.5 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors text-zinc-500"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>
          <div className="flex-1 min-h-0 overflow-auto px-4 py-3">
            {isEmpty ? (
              <p className="text-sm text-zinc-400 italic">
                No content available — this row was created before content tracking was enabled, or the fact was stored
                without content.
              </p>
            ) : (
              <pre className="text-sm whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-200 font-sans leading-relaxed">
                {content}
              </pre>
            )}
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-400">
              <div>Source: {fact.source}</div>
              <div>Status: {fact.status}</div>
              <div>Reinforce: {fact.reinforceCount}</div>
              <div>Hits: {fact.hitCount}</div>
              <div>First seen: {formatMemoryDate(fact.firstSeen)}</div>
              <div>Last reinforced: {formatMemoryDate(fact.lastReinforced)}</div>
            </div>
          </div>
          <div className="shrink-0 px-4 py-3 border-t border-zinc-200 dark:border-zinc-700 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleCopy}
              disabled={isEmpty}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-zinc-100 dark:bg-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Copy className="w-3.5 h-3.5" />
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-lg bg-purple-500 hover:bg-purple-600 text-white transition-colors"
            >
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
