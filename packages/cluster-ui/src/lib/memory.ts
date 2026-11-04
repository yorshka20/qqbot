import { useSyncExternalStore } from 'react';

/**
 * What only this browser knows. Phase 1 has no server-side stage, so "seen" lives here; the
 * daemon does not expose an answered request either, so the timeline shows the answers given
 * from this browser and a bare "已回答" for any other.
 */
const SEEN_KEY = 'cluster-ui.seen';
const ANSWERS_KEY = 'cluster-ui.answers';
const MAX_ENTRIES = 500;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or a full quota: the state simply lasts for this page view.
  }
}

let seen: ReadonlySet<string> = new Set(read<string[]>(SEEN_KEY, []));
let answers: ReadonlyMap<string, string> = new Map(read<[string, string][]>(ANSWERS_KEY, []));
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSeen(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => seen);
}

export function useAnswers(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, () => answers);
}

export function markSeen(taskId: string): void {
  if (seen.has(taskId)) {
    return;
  }
  const next = [...seen, taskId].slice(-MAX_ENTRIES);
  seen = new Set(next);
  write(SEEN_KEY, next);
  notify();
}

export function rememberAnswer(askId: string, answer: string): void {
  const next = [...answers, [askId, answer] as [string, string]].slice(-MAX_ENTRIES);
  answers = new Map(next);
  write(ANSWERS_KEY, next);
  notify();
}
