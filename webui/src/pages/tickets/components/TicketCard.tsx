import type { ReactNode } from 'react';

/**
 * Card wrapper used by every panel on the tickets page. Page-local copy
 * of the same shape used by ClusterCard / LanCard — duplicated rather
 * than promoted to a shared component because each page is allowed to
 * tweak its own visual contract without affecting the others.
 */
export function TicketCard({
  title,
  count,
  right,
  children,
}: {
  title: string;
  count?: number;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4">
      <div className="flex items-center gap-3 mb-3">
        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</div>
        {typeof count === 'number' && (
          <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">({count})</div>
        )}
        <div className="flex-1" />
        {right}
      </div>
      {children}
    </div>
  );
}
