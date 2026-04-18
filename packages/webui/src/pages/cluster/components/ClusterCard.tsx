import type { ReactNode } from 'react';

export function ClusterCard({
  title,
  count,
  children,
  right,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  right?: ReactNode;
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
