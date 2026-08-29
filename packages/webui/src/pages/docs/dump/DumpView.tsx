import { useState } from 'react';

import type { DumpEntry, DumpFile } from './parseDump';
import { SectionBlock } from './sections';

function EntryCard({ entry, index, total }: { entry: DumpEntry; index: number; total: number }) {
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 p-3">
      <header className="flex flex-wrap items-center gap-2 mb-2">
        {total > 1 && <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono">#{index + 1}</span>}
        <span className="font-mono text-sm font-semibold text-zinc-800 dark:text-zinc-100">{entry.time}</span>
        <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
          {entry.op}
        </span>
        <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
          {entry.provider}
        </span>
        {entry.model && <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono">{entry.model}</span>}
      </header>

      <div className="space-y-2">
        {entry.sections.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: section order is the identity
          <SectionBlock key={i} section={s} />
        ))}
      </div>

      {entry.stats.length > 0 && (
        <footer className="flex flex-wrap gap-2 mt-2">
          {entry.stats.map((s) => (
            <span
              key={s}
              className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
            >
              {s}
            </span>
          ))}
        </footer>
      )}
    </section>
  );
}

export function DumpView({ dump }: { dump: DumpFile }) {
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h1 className="text-base font-semibold text-zinc-800 dark:text-zinc-100">{dump.title}</h1>
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="text-xs px-2 py-1 rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
        >
          {showRaw ? '结构化视图' : '查看原文'}
        </button>
      </div>

      {showRaw ? (
        <pre className="text-xs whitespace-pre-wrap break-words font-mono bg-white dark:bg-zinc-800 rounded-lg p-4 border border-zinc-200 dark:border-zinc-700">
          {dump.raw}
        </pre>
      ) : (
        <div className="space-y-4">
          {dump.entries.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: entry order is the identity
            <EntryCard key={i} entry={e} index={i} total={dump.entries.length} />
          ))}
        </div>
      )}
    </div>
  );
}
