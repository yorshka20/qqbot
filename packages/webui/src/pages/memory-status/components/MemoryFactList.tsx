import { ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { deleteMemoryFact, updateMemoryFact } from '../../../api';
import type { MemoryFactDurability, MemoryFactEntry } from '../../../types';
import { buildScopeTree, formatMemoryDate, type ScopeNode, scopeFactCount } from '../utils';
import { HighlightText } from './HighlightText';
import { MemoryDurabilityBadge, MemoryStatusBadge } from './MemoryBadges';

/** Automatic facts grouped by scope, each correctable or deletable in place. */
export function MemoryFactList({
  facts,
  query,
  onChanged,
}: {
  facts: MemoryFactEntry[];
  query: string;
  onChanged: () => void;
}) {
  const tree = useMemo(() => buildScopeTree(facts), [facts]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (facts.length === 0) {
    return <p className="px-4 py-6 text-sm text-zinc-400">没有匹配的自动记忆</p>;
  }

  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  const renderNode = (node: ScopeNode, depth: number) => {
    const open = !collapsed.has(node.key);
    return (
      <section key={node.key} className={depth > 0 ? 'ml-4' : ''}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => toggle(node.key)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left rounded-md hover:bg-zinc-50 dark:hover:bg-zinc-700/40"
        >
          {open ? (
            <ChevronDown className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
          )}
          <span className="font-mono text-sm">{node.label}</span>
          {node.gloss && <span className="text-xs text-zinc-400">{node.gloss}</span>}
          <span className="text-xs text-zinc-400">{scopeFactCount(node)}</span>
        </button>
        {open && (
          <div className="pb-1">
            {node.facts.map((fact) => (
              <FactRow key={fact.id} fact={fact} query={query} onChanged={onChanged} />
            ))}
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </section>
    );
  };

  return <div className="py-2 space-y-1">{tree.map((node) => renderNode(node, 0))}</div>;
}

function FactRow({ fact, query, onChanged }: { fact: MemoryFactEntry; query: string; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(fact.content);
  const [scope, setScope] = useState(fact.scope);
  const [durability, setDurability] = useState<MemoryFactDurability>(fact.durability);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEdit = () => {
    setContent(fact.content);
    setScope(fact.scope);
    setDurability(fact.durability);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateMemoryFact(fact.id, { content, scope, durability });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`删除这条记忆？\n\n${fact.content}`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteMemoryFact(fact.id);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
      setBusy(false);
    }
  };

  const inactive = fact.status !== 'active';
  return (
    <div
      className={`group px-4 py-2 ml-5 border-l border-zinc-100 dark:border-zinc-700 ${inactive ? 'opacity-60' : ''}`}
    >
      {editing ? (
        <div className="space-y-2">
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={2}
            aria-label="记忆内容"
            className="w-full px-2 py-1.5 text-sm rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 resize-y"
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              aria-label="scope"
              className="px-2 py-1 text-xs font-mono rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
            />
            <select
              value={durability}
              onChange={(event) => setDurability(event.target.value as MemoryFactDurability)}
              aria-label="时效"
              className="px-2 py-1 text-xs rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
            >
              <option value="stable">长期</option>
              <option value="transient">临时</option>
            </select>
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={busy}
                className="text-xs px-2 py-1 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700"
              >
                取消
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy || !content.trim()}
                className="text-xs px-2 py-1 rounded-md bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-50"
              >
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <p className="flex-1 min-w-0 text-sm leading-relaxed break-words">
            <HighlightText text={fact.content} query={query} />
          </p>
          <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              onClick={startEdit}
              disabled={busy}
              title="修改"
              className="p-1 rounded-md text-zinc-400 hover:text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-950/40"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              title="删除"
              className="p-1 rounded-md text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
        <MemoryDurabilityBadge durability={fact.durability} />
        {inactive && <MemoryStatusBadge status={fact.status} />}
        {inactive && fact.statusReason && <span>{fact.statusReason}</span>}
        <span>首次 {formatMemoryDate(fact.firstSeen)}</span>
        <span>最近提到 {formatMemoryDate(fact.lastConfirmedAt)}</span>
        <span>提到 {fact.confirmCount} 次</span>
        <span>
          检索命中 {fact.hitCount} 次{fact.lastHitAt ? `（最近 ${formatMemoryDate(fact.lastHitAt)}）` : ''}
        </span>
        {fact.reviewedAt && <span>复审于 {formatMemoryDate(fact.reviewedAt)}</span>}
      </div>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
