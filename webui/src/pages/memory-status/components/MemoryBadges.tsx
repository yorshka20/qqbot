export function MemoryStatusBadge({ status }: { status: string }) {
  const cls =
    status === 'active'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{status}</span>;
}

export function MemorySourceBadge({ source }: { source: string }) {
  const cls =
    source === 'manual'
      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
      : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300';
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{source === 'manual' ? 'manual' : 'auto'}</span>
  );
}
