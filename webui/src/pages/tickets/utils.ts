import type { TicketStatus } from '../../types';

/**
 * Tailwind class set for a ticket status badge. Colors mirror cluster
 * task status (`pages/cluster/utils.ts#statusBadgeClass`) where the
 * concepts overlap (done = green, dispatched = blue) so the visual
 * vocabulary stays consistent across pages.
 */
export function ticketStatusBadgeClass(status: TicketStatus): string {
  switch (status) {
    case 'done':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300';
    case 'dispatched':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300';
    case 'ready':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300';
    case 'abandoned':
      return 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400 line-through';
    default:
      // draft
      return 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  }
}

/**
 * Format an ISO-8601 timestamp into the local time zone, dropping the
 * year for current-year timestamps to keep the listing compact.
 */
export function formatTicketTimestamp(iso: string): string {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    const now = new Date();
    if (d.getFullYear() === now.getFullYear()) {
      return d.toLocaleString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

// Ticket body templates are now loaded from the file `tickets/_template.md`
// via `GET /api/tickets/template`. There is no hardcoded fallback body.

/**
 * Tailwind classes for a project badge — stable color derived from the
 * alias hash so the same project always renders with the same tone,
 * making cross-row project membership visually obvious. Palette picked
 * to avoid colliding with status (amber/blue/emerald) and template role
 * (violet/sky) tones.
 */
const PROJECT_TONES = [
  'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300',
  'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
  'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
  'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-300',
  'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  'bg-lime-100 text-lime-800 dark:bg-lime-900/40 dark:text-lime-300',
  'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300',
  'bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300',
];

export function projectBadgeClass(alias: string): string {
  let hash = 0;
  for (let i = 0; i < alias.length; i++) {
    hash = (hash * 31 + alias.charCodeAt(i)) | 0;
  }
  return PROJECT_TONES[Math.abs(hash) % PROJECT_TONES.length];
}

/**
 * Tailwind classes for a template role badge. Mirrors the tones used by
 * `TemplateSelect` so the planner/executor distinction is visually
 * consistent across the editor dropdown and the ticket list.
 */
export function templateRoleBadgeClass(role: 'planner' | 'executor'): string {
  return role === 'planner'
    ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
    : 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300';
}
