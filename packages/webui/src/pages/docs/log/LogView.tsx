import { ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { LogEntry, LogFile } from './parseLog';

const LEVEL_CHIP: Record<string, string> = {
  ERROR: 'bg-red-100 text-red-700 dark:bg-red-900/60 dark:text-red-300',
  WARN: 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300',
  INFO: 'bg-sky-100 text-sky-700 dark:bg-sky-900/60 dark:text-sky-300',
  DEBUG: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300',
};
const FALLBACK_CHIP = 'bg-violet-100 text-violet-700 dark:bg-violet-900/60 dark:text-violet-300';

const ROW_ACCENT: Record<string, string> = {
  ERROR: 'border-l-2 border-red-400 dark:border-red-700 bg-red-50/50 dark:bg-red-950/20',
  WARN: 'border-l-2 border-amber-400 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-950/20',
};

const PAGE = 500;

function EntryRow({ entry }: { entry: LogEntry }) {
  const chip = entry.level ? (LEVEL_CHIP[entry.level] ?? FALLBACK_CHIP) : null;

  return (
    <div
      className={`px-2 py-0.5 font-mono text-xs leading-5 ${ROW_ACCENT[entry.level ?? ''] ?? 'border-l-2 border-transparent'}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        {entry.time && (
          <span className="shrink-0 text-zinc-400 dark:text-zinc-500" title={entry.time}>
            {entry.time.slice(11)}
          </span>
        )}
        {chip && <span className={`shrink-0 rounded px-1 text-[10px] font-semibold ${chip}`}>{entry.level}</span>}
        {entry.tags.map((t, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: tag order is the identity
            key={i}
            className="shrink-0 text-violet-600 dark:text-violet-400"
          >
            [{t}]
          </span>
        ))}
        {/* min-w-0 lets the flex item shrink past its min-content width; without it a long
            unbroken token (URL, base64, JSON blob) widens the row into a horizontal scroll. */}
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-zinc-800 dark:text-zinc-200">
          {entry.message}
        </span>
      </div>

      {entry.body.length > 0 && (
        <details className="group mt-0.5">
          <summary className="flex cursor-pointer select-none items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500 list-none [&::-webkit-details-marker]:hidden hover:text-zinc-600 dark:hover:text-zinc-300">
            <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" />
            {entry.body.length} 行详情
          </summary>
          <pre className="mt-1 whitespace-pre-wrap break-all rounded border border-zinc-200 bg-white p-2 text-[11px] text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {entry.body.join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}

export function LogView({ log }: { log: LogFile }) {
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q && hidden.size === 0) {
      return log.entries;
    }
    return log.entries.filter((e) => {
      if (e.level !== null && hidden.has(e.level)) {
        return false;
      }
      return !q || e.haystack.includes(q);
    });
  }, [log.entries, query, hidden]);

  // Newest lines sit at the end of a log file, so the window opens on the tail
  // and grows upward — a 40k-line file would otherwise render 40k rows.
  const hiddenCount = Math.max(0, filtered.length - limit);
  const shown = hiddenCount > 0 ? filtered.slice(hiddenCount) : filtered;

  const toggleLevel = (level: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(PAGE);
          }}
          placeholder="过滤日志..."
          className="w-56 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500"
        />
        {log.levels.map(({ level, count }) => (
          <button
            key={level}
            type="button"
            onClick={() => toggleLevel(level)}
            className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold transition-opacity ${
              LEVEL_CHIP[level] ?? FALLBACK_CHIP
            } ${hidden.has(level) ? 'opacity-30' : ''}`}
            title={hidden.has(level) ? '显示该级别' : '隐藏该级别'}
          >
            {level} {count}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-zinc-400 dark:text-zinc-500">
          {shown.length} / {log.entries.length} 条
        </span>
      </div>

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setLimit((n) => n + PAGE * 4)}
          className="rounded-lg border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700"
        >
          加载更早的 {Math.min(hiddenCount, PAGE * 4)} 条（还有 {hiddenCount} 条）
        </button>
      )}

      <div className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-700 dark:bg-zinc-800/60">
        {shown.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-zinc-400 dark:text-zinc-500">没有匹配的日志行</p>
        ) : (
          shown.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: entry order is the identity
            <EntryRow key={hiddenCount + i} entry={e} />
          ))
        )}
      </div>
    </div>
  );
}
