import { useCallback, useSyncExternalStore } from 'react';

/** The pane shows the tail: `task_output` carries the whole stdout, which can reach megabytes. */
export const OUTPUT_TAIL_CHARS = 256 * 1024;

const outputs = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

export function setOutput(taskId: string, output: string): void {
  const tail = output.length > OUTPUT_TAIL_CHARS ? output.slice(-OUTPUT_TAIL_CHARS) : output;
  if (outputs.get(taskId) === tail) {
    return;
  }
  outputs.set(taskId, tail);
  for (const listener of listeners.get(taskId) ?? []) {
    listener();
  }
}

export function hasOutput(taskId: string): boolean {
  return outputs.has(taskId);
}

export function useOutput(taskId: string): string {
  const subscribe = useCallback(
    (listener: () => void) => {
      const set = listeners.get(taskId) ?? new Set();
      listeners.set(taskId, set);
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    [taskId],
  );
  return useSyncExternalStore(subscribe, () => outputs.get(taskId) ?? '');
}
