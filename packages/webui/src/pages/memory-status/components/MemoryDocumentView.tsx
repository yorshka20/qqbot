import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { parseMemoryDocument, SCOPE_GLOSS, splitScope } from '../utils';
import { HighlightText } from './HighlightText';

export function MemoryDocumentView({ text, query }: { text: string; query: string }) {
  const sections = useMemo(() => parseMemoryDocument(text), [text]);
  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!needle) {
      return sections;
    }
    return sections.filter(
      (section) => section.scope.toLowerCase().includes(needle) || section.content.toLowerCase().includes(needle),
    );
  }, [sections, needle]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (sections.length === 0) {
    return <p className="px-4 py-6 text-sm text-zinc-400">还没有自动记忆</p>;
  }
  if (visible.length === 0) {
    return <p className="px-4 py-6 text-sm text-zinc-400">没有匹配的记忆</p>;
  }

  const keys = visible.map((section, index) => `${section.scope}:${index}`);
  const allCollapsed = keys.every((key) => collapsed.has(key));

  return (
    <div className="py-2">
      <div className="px-4 pb-1 flex justify-end">
        <button
          type="button"
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(keys))}
          className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
        >
          {allCollapsed ? '展开全部分类' : '收起全部分类'}
        </button>
      </div>
      <div className="space-y-1">
        {visible.map((section, index) => {
          const key = `${section.scope}:${index}`;
          const open = !collapsed.has(key);
          const { core, subtag } = splitScope(section.scope);
          const gloss = SCOPE_GLOSS[core];
          return (
            <section key={key}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => {
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(key)) {
                      next.delete(key);
                    } else {
                      next.add(key);
                    }
                    return next;
                  });
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left rounded-md hover:bg-zinc-50 dark:hover:bg-zinc-700/40"
              >
                {open ? (
                  <ChevronDown className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
                )}
                {section.scope ? (
                  <>
                    <span className="font-mono text-sm">{core}</span>
                    {gloss && <span className="text-xs text-zinc-400">{gloss}</span>}
                    {subtag && <span className="font-mono text-xs text-zinc-500">{subtag}</span>}
                  </>
                ) : (
                  <span className="text-sm text-zinc-500">正文</span>
                )}
              </button>
              {open && (
                <p className="px-4 pb-3 text-sm leading-relaxed whitespace-pre-wrap break-words">
                  <HighlightText text={section.content} query={query} />
                </p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
