/**
 * Default scroll area for Cluster page list cards — keeps blocks from growing
 * with content; scroll inside the card instead.
 */
export const CLUSTER_CARD_BODY_SCROLL =
  'max-h-[min(42vh,24rem)] overflow-y-auto overflow-x-hidden overscroll-contain pr-0.5';

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

export function formatTimestamp(iso?: string): string {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

/** Local date/time string from epoch ms (WebUI cluster worker spawned/exited). */
export function formatEpoch(epoch?: number): string {
  if (epoch == null || !Number.isFinite(epoch)) {
    return '-';
  }
  try {
    return new Date(epoch).toLocaleString();
  } catch {
    return '-';
  }
}

import type { ClusterEventEntry } from '../../types';

/**
 * Human-readable one-line summary for cluster event log rows (replaces raw JSON in the main view).
 */
export function formatClusterEventSummary(ev: ClusterEventEntry): string {
  const d = ev.data ?? {};
  switch (ev.type) {
    case 'file_changed':
      return `Files: ${(d.filesModified as string[] | undefined)?.join(', ') || '—'}`;
    case 'worker_progress': {
      const s = String(d.summary ?? '').trim();
      const n = d.nextSteps ? ` → Next: ${String(d.nextSteps)}` : '';
      return (s + n).trim() || 'Progress';
    }
    case 'task_completed':
      return `Completed: ${String(d.summary ?? '').trim() || '—'}`;
    case 'task_failed':
      return `Failed: ${String(d.summary ?? '').trim() || '—'}`;
    case 'task_blocked':
      return `Blocked: ${String(d.summary ?? '').trim() || '—'}`;
    case 'lock_acquired': {
      const files = d.files as string[] | undefined;
      return `Lock: ${files?.join(', ') || String(d.file ?? '') || '—'}`;
    }
    case 'lock_released':
      return `Unlock: ${String(d.file ?? '—')}`;
    case 'worker_joined': {
      const bits = [d.template, d.project].filter(Boolean).map(String);
      return bits.length ? `Joined · ${bits.join(' · ')}` : 'Worker joined';
    }
    case 'worker_left':
      return 'Worker left';
    case 'help_request':
      return `Help: ${String(d.question ?? '').slice(0, 240)}${String(d.question ?? '').length > 240 ? '…' : ''}`;
    case 'message':
      return `Message: ${String(d.content ?? '').slice(0, 240)}`;
    case 'answer':
      return `Answer: ${String(d.content ?? '').slice(0, 240)}`;
    case 'directive':
      return `Directive: ${String(d.content ?? '').slice(0, 240)}`;
    default: {
      const s = String(d.summary ?? d.question ?? d.content ?? '').trim();
      if (s) {
        return s.slice(0, 200);
      }
      try {
        const raw = JSON.stringify(d);
        return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
      } catch {
        return ev.type;
      }
    }
  }
}

export function statusBadgeClass(status: string): string {
  switch (status) {
    case 'completed':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300';
    case 'failed':
      return 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300';
    case 'running':
    case 'in_progress':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300';
    case 'pending':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300';
    case 'blocked':
      return 'bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300';
    default:
      return 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  }
}
