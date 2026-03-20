/**
 * Qdrant Explorer page: browse collections and perform vector search.
 */
/** biome-ignore-all lint/suspicious/noArrayIndexKey: <explanation> */
/** biome-ignore-all lint/a11y/noLabelWithoutControl: <explanation> */

import { Database, Loader2, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listQdrantCollections, scrollQdrant, searchQdrant } from '../api';
import type { QdrantCollectionInfo, QdrantSearchHit } from '../types';

type ViewMode = 'search' | 'browse';

export function QdrantExplorerPage() {
  // Collections
  const [collections, setCollections] = useState<QdrantCollectionInfo[]>([]);
  const [selectedCollection, setSelectedCollection] = useState('');
  const [loadingCollections, setLoadingCollections] = useState(true);
  const [collectionsError, setCollectionsError] = useState('');

  // Search
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(20);
  const [minScore, setMinScore] = useState(0.3);
  const [viewMode, setViewMode] = useState<ViewMode>('search');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<QdrantSearchHit[]>([]);
  const [browsePoints, setBrowsePoints] = useState<Array<{ id: string | number; payload: Record<string, unknown> }>>(
    [],
  );
  const [searchError, setSearchError] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string | number>>(new Set());

  const inputRef = useRef<HTMLInputElement>(null);

  // Load collections on mount
  useEffect(() => {
    setLoadingCollections(true);
    setCollectionsError('');
    listQdrantCollections()
      .then((res) => {
        const sorted = [...res.collections].sort((a, b) => b.pointsCount - a.pointsCount);
        setCollections(sorted);
        if (sorted.length > 0 && !selectedCollection) {
          setSelectedCollection(sorted[0].name);
        }
      })
      .catch((err) => setCollectionsError(err.message))
      .finally(() => setLoadingCollections(false));
  }, [selectedCollection]);

  // Perform search
  const doSearch = useCallback(async () => {
    if (!selectedCollection) return;
    setSearching(true);
    setSearchError('');
    setResults([]);
    setBrowsePoints([]);
    setExpandedIds(new Set());
    try {
      if (viewMode === 'search') {
        if (!query.trim()) {
          setSearchError('请输入搜索内容');
          return;
        }
        const res = await searchQdrant({ collection: selectedCollection, q: query, limit, minScore });
        setResults(res.results);
      } else {
        const res = await scrollQdrant({ collection: selectedCollection, limit });
        setBrowsePoints(res.points);
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }, [selectedCollection, query, limit, minScore, viewMode]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      doSearch();
    }
  };

  const toggleExpand = (id: string | number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedInfo = collections.find((c) => c.name === selectedCollection);

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Database className="w-5 h-5 text-indigo-500" />
        <h1 className="text-lg font-semibold">Qdrant Explorer</h1>
      </div>

      {/* Collection selector + controls */}
      <div className="bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 p-4 space-y-3">
        {/* Collection selector */}
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm font-medium text-zinc-600 dark:text-zinc-400 shrink-0">Collection</label>
          {loadingCollections ? (
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              加载中...
            </div>
          ) : collectionsError ? (
            <span className="text-sm text-red-500">{collectionsError}</span>
          ) : (
            <select
              value={selectedCollection}
              onChange={(e) => {
                setSelectedCollection(e.target.value);
                setResults([]);
                setBrowsePoints([]);
              }}
              className="flex-1 min-w-[200px] px-3 py-1.5 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {collections.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.pointsCount.toLocaleString()} points)
                </option>
              ))}
            </select>
          )}
          {selectedInfo && (
            <span className="text-xs text-zinc-400">
              {selectedInfo.vectorSize}d · {selectedInfo.distance}
            </span>
          )}
        </div>

        {/* View mode toggle */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setViewMode('search');
              setResults([]);
              setBrowsePoints([]);
            }}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              viewMode === 'search'
                ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300'
                : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700'
            }`}
          >
            向量搜索
          </button>
          <button
            type="button"
            onClick={() => {
              setViewMode('browse');
              setResults([]);
              setBrowsePoints([]);
            }}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              viewMode === 'browse'
                ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300'
                : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700'
            }`}
          >
            浏览数据
          </button>
        </div>

        {/* Search bar */}
        <div className="flex items-center gap-2">
          {viewMode === 'search' && (
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入文本进行语义搜索..."
                className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          )}
          <div className="flex items-center gap-2 shrink-0">
            <label className="text-xs text-zinc-500">Limit</label>
            <input
              type="number"
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(100, Number(e.target.value))))}
              className="w-16 px-2 py-1.5 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            {viewMode === 'search' && (
              <>
                <label className="text-xs text-zinc-500">Min Score</label>
                <input
                  type="number"
                  step="0.05"
                  value={minScore}
                  onChange={(e) => setMinScore(Math.max(0, Math.min(1, Number(e.target.value))))}
                  className="w-20 px-2 py-1.5 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </>
            )}
            <button
              type="button"
              onClick={doSearch}
              disabled={searching || !selectedCollection}
              className="px-4 py-1.5 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
            >
              {searching && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {viewMode === 'search' ? '搜索' : '加载'}
            </button>
          </div>
        </div>
      </div>

      {/* Error */}
      {searchError && (
        <div className="px-4 py-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
          {searchError}
        </div>
      )}

      {/* Results */}
      {viewMode === 'search' && results.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm text-zinc-500 dark:text-zinc-400">找到 {results.length} 条结果</div>
          {results.map((hit, idx) => (
            <PointCard
              key={`${hit.id}-${idx}`}
              id={hit.id}
              payload={hit.payload}
              score={hit.score}
              expanded={expandedIds.has(hit.id)}
              onToggle={() => toggleExpand(hit.id)}
            />
          ))}
        </div>
      )}

      {viewMode === 'browse' && browsePoints.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm text-zinc-500 dark:text-zinc-400">共 {browsePoints.length} 条记录</div>
          {browsePoints.map((pt, idx) => (
            <PointCard
              key={`${pt.id}-${idx}`}
              id={pt.id}
              payload={pt.payload}
              expanded={expandedIds.has(pt.id)}
              onToggle={() => toggleExpand(pt.id)}
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!searching && !searchError && results.length === 0 && browsePoints.length === 0 && selectedCollection && (
        <div className="text-center py-12 text-zinc-400 dark:text-zinc-500 text-sm">
          {viewMode === 'search' ? '输入文本进行语义搜索' : '点击「加载」浏览数据'}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Point card component
// ────────────────────────────────────────────────────────────────────────────

function PointCard({
  id,
  payload,
  score,
  expanded,
  onToggle,
}: {
  id: string | number;
  payload: Record<string, unknown>;
  score?: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  // Extract content field for preview if present
  const content = (payload.content as string) ?? '';
  const preview = content.length > 200 ? `${content.slice(0, 200)}...` : content;

  return (
    <div className="bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-750 transition-colors"
      >
        <span className="text-xs font-mono text-zinc-400 dark:text-zinc-500 shrink-0 max-w-[180px] truncate">
          {String(id)}
        </span>
        {score != null && (
          <span className="shrink-0 px-2 py-0.5 text-xs font-medium rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300">
            {score.toFixed(4)}
          </span>
        )}
        <span className="flex-1 text-sm text-zinc-700 dark:text-zinc-300 truncate">{preview || '(no content)'}</span>
        <span className="text-xs text-zinc-400 shrink-0">{expanded ? '收起' : '展开'}</span>
      </button>

      {/* Expanded payload */}
      {expanded && (
        <div className="border-t border-zinc-100 dark:border-zinc-700 px-4 py-3">
          <PayloadView payload={payload} />
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Payload renderer
// ────────────────────────────────────────────────────────────────────────────

function PayloadView({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload);
  if (entries.length === 0) {
    return <span className="text-sm text-zinc-400">(empty payload)</span>;
  }

  return (
    <div className="space-y-2">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-2">
          <span className="shrink-0 text-xs font-medium text-indigo-600 dark:text-indigo-400 min-w-[100px] pt-0.5">
            {key}
          </span>
          <div className="flex-1 text-sm text-zinc-700 dark:text-zinc-300 break-all whitespace-pre-wrap">
            {renderValue(value)}
          </div>
        </div>
      ))}
    </div>
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '(null)';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    // For simple arrays (strings, numbers), show inline
    if (value.every((v) => typeof v === 'string' || typeof v === 'number')) {
      return value.join(', ');
    }
    return JSON.stringify(value, null, 2);
  }
  return JSON.stringify(value, null, 2);
}
