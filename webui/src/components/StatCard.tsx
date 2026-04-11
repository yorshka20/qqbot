import type { ReactNode } from 'react';

export function StatCard({
  icon,
  label,
  value,
  subValue,
  color,
}: {
  icon: ReactNode;
  label: string;
  value: string | number;
  subValue?: string;
  color: string;
}) {
  return (
    <div className="bg-white dark:bg-zinc-800 rounded-xl p-4 border border-zinc-200 dark:border-zinc-700">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg ${color}`}>{icon}</div>
        <div className="min-w-0">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{label}</p>
          <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{value}</p>
          {subValue && (
            <p className="text-xs text-zinc-400 dark:text-zinc-500 truncate">{subValue}</p>
          )}
        </div>
      </div>
    </div>
  );
}
