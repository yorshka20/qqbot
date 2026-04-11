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
