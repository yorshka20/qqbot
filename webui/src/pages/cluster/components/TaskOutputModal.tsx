import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import type { ClusterTask } from '../../../types';
import { ClusterStatusBadge } from './ClusterStatusBadge';
import { formatTimestamp } from '../utils';

export function TaskOutputModal({
  task,
  onClose,
}: {
  task: ClusterTask;
  onClose: () => void;
}) {
  return (
    <Dialog.Root
      open={true}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(90vw,80rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl bg-white dark:bg-zinc-800 shadow-2xl flex flex-col focus:outline-none">
          <div className="shrink-0 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-3">
            <Dialog.Title className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Task {task.id.slice(0, 8)}
            </Dialog.Title>
            <ClusterStatusBadge status={task.status} />
            <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono truncate min-w-0">
              {task.workerTemplate ?? '-'} · worker {task.workerId ?? '-'}
            </div>
            <div className="flex-1" />
            <Dialog.Close asChild>
              <button
                type="button"
                className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </Dialog.Close>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1">Description</div>
              <div className="text-sm text-zinc-800 dark:text-zinc-100 whitespace-pre-wrap">{task.description}</div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs text-zinc-500 dark:text-zinc-400">
              <div>
                <div className="font-medium text-zinc-700 dark:text-zinc-300">Created</div>
                {formatTimestamp(task.createdAt)}
              </div>
              <div>
                <div className="font-medium text-zinc-700 dark:text-zinc-300">Completed</div>
                {formatTimestamp(task.completedAt)}
              </div>
            </div>
            {task.output && (
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1">Output</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
                  Worker CLI stdout (stream-json may be parsed to a cleaner final message when the backend supports it).
                </div>
                <pre className="text-xs whitespace-pre-wrap break-words bg-zinc-100 dark:bg-zinc-900 p-3 rounded-lg text-zinc-800 dark:text-zinc-100 max-h-[40vh] overflow-y-auto">
                  {task.output}
                </pre>
              </div>
            )}
            {task.error && (
              <div>
                <div className="text-xs uppercase tracking-wide text-red-500 dark:text-red-400 mb-1">Error</div>
                <pre className="text-xs whitespace-pre-wrap break-words bg-red-50 dark:bg-red-950/30 p-3 rounded-lg text-red-700 dark:text-red-300">
                  {task.error}
                </pre>
              </div>
            )}
            {task.metadata != null && (
              <details className="text-xs">
                <summary className="cursor-pointer text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
                  Raw metadata
                </summary>
                <pre className="mt-2 whitespace-pre-wrap break-words bg-zinc-100 dark:bg-zinc-900 p-3 rounded-lg text-zinc-700 dark:text-zinc-200 max-h-[30vh] overflow-y-auto">
                  {typeof task.metadata === 'string' ? task.metadata : JSON.stringify(task.metadata, null, 2)}
                </pre>
              </details>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
