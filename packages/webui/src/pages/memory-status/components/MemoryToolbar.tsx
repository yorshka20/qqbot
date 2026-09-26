import { Search } from 'lucide-react';
import type { MemorySourceFilter, MemoryStatusFilter } from '../utils';

const STATUS_OPTIONS: Array<{ value: MemoryStatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '有效' },
  { value: 'stale', label: '过期' },
];

const SOURCE_OPTIONS: Array<{ value: MemorySourceFilter; label: string }> = [
  { value: 'all', label: '全部来源' },
  { value: 'manual', label: '手动' },
  { value: 'llm_extract', label: '自动' },
];

export function MemoryToolbar({
  query,
  onQueryChange,
  status,
  onStatusChange,
  source,
  onSourceChange,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  status: MemoryStatusFilter;
  onStatusChange: (value: MemoryStatusFilter) => void;
  source: MemorySourceFilter;
  onSourceChange: (value: MemorySourceFilter) => void;
}) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
      <label className="relative flex-1 min-w-0">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索群名、昵称、QQ 号或记忆内容"
          aria-label="搜索记忆"
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
        />
      </label>
      <Segmented options={STATUS_OPTIONS} value={status} onChange={onStatusChange} label="按状态筛选" />
      <Segmented options={SOURCE_OPTIONS} value={source} onChange={onSourceChange} label="按来源筛选" />
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <fieldset
      aria-label={label}
      className="inline-flex self-start rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden bg-white dark:bg-zinc-900 shrink-0 m-0 p-0 min-w-0"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={`px-3 py-2 text-xs font-medium transition-colors ${
              selected
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-500 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}
