import type { MemoryFactDurability, MemoryFactStatus } from '../../../types';
import { STATUS_LABEL } from '../utils';

const STATUS_CLASS: Record<MemoryFactStatus, string> = {
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  superseded: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400',
  retired: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
};

export function MemoryStatusBadge({ status }: { status: MemoryFactStatus }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASS[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function MemoryDurabilityBadge({ durability }: { durability: MemoryFactDurability }) {
  const stable = durability === 'stable';
  const cls = stable
    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
    : 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400';
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{stable ? '长期' : '临时'}</span>;
}
