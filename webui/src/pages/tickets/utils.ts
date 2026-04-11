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

/**
 * Default body content for a freshly-created ticket. Uses a plain
 * markdown skeleton — same sections the planner / executor agents are
 * trained to look for. Keep this in sync with the prompt expectations
 * in `prompts/cluster-worker-system.md` if those evolve.
 */
export const DEFAULT_TICKET_BODY = `## Goal

(What outcome do you want? One or two sentences.)

## Context

- Relevant files / modules:
- Current behavior:
- Why this matters:

## Acceptance criteria

- [ ] (Concrete, checkable criterion 1)
- [ ] (Concrete, checkable criterion 2)

## Out of scope

- (Things the worker should NOT touch)

## Notes

(Anything else the worker needs to know)
`;
