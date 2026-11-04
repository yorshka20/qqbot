import { useSyncExternalStore } from 'react';
import { readPinnedTasks, rememberPinnedTasks } from '../lib/memory';

let pinned: ReadonlySet<string> = new Set(readPinnedTasks());
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function togglePinned(taskId: string): void {
  const next = new Set(pinned);
  if (!next.delete(taskId)) {
    next.add(taskId);
  }
  pinned = next;
  rememberPinnedTasks([...next]);
  for (const listener of listeners) {
    listener();
  }
}

export function usePinned(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => pinned);
}
