/**
 * Zhihu Page - Browse Zhihu feed items with excerpts and links to originals.
 * Supports filtering by type (article/answer), keyword search, and date range.
 */

import { Calendar, ExternalLink, FileText, MessageSquare, Search, ThumbsUp } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { getZhihuStats, listZhihuContents } from '../api';
import type { ZhihuContentListItem, ZhihuPageStats } from '../types';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function toDateKey(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function toDateLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const key = d.toDateString();
  if (key === today.toDateString()) return '今天';
  if (key === yesterday.toDateString()) return '昨天';
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
}

function groupByDate(items: ZhihuContentListItem[]): Array<{ dateKey: string; label: string; items: ZhihuContentListItem[] }> {
  const map = new Map<string, ZhihuContentListItem[]>();
  for (const item of items) {
    const key = toDateKey(item.createdTime);
    const arr = map.get(key);
    if (arr) arr.push(item);
    else map.set(key, [item]);
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([dateKey, groupItems]) => ({
      dateKey,
      label: toDateLabel(groupItems[0].createdTime),
      items: groupItems,
    }));
}

// ────────────────────────────────────────────────────────────────────────────
// Date presets
// ────────────────────────────────────────────────────────────────────────────

type DatePreset = '全部' | '今天' | '近3天' | '近7天' | '近30天';
const DATE_PRESETS: DatePreset[] = ['全部', '今天', '近3天', '近7天', '近30天'];

function getPresetSinceTs(preset: DatePreset): number | undefined {
  if (preset === '全部') return undefined;
  const now = Math.floor(Date.now() / 1000);
  const days = preset === '今天' ? 1 : preset === '近3天' ? 3 : preset === '近7天' ? 7 : 30;
  return now - days * 86400;
}

// ────────────────────────────────────────────────────────────────────────────
// Main Page
// ────────────────────────────────────────────────────────────────────────────

export function ZhihuPage() {
  const [allContents, setAllContents] = useState<ZhihuContentListItem[]>([]);
  const [stats, setStats] = useState<ZhihuPageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [datePreset, setDatePreset] = useState<DatePreset>('全部');
  const [keyword, setKeyword] = useState('');
  const [searchInput, setSearchInput] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sinceTs = getPresetSinceTs(datePreset);
      const [listRes, statsRes] = await Promise.all([
        listZhihuContents({ type: typeFilter || undefined, sinceTs, keyword: keyword || undefined }),
        getZhihuStats(),
      ]);
      setAllContents(listRes.contents);
      setStats(statsRes.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [typeFilter, datePreset, keyword]);

  useEffect(() => {
    load();
  }, [load]);

  // Group by date
  const groups = useMemo(() => groupByDate(allContents), [allContents]);

  const handleSearch = useCallback(() => {
    setKeyword(searchInput.trim());
  }, [searchInput]);

  return (
    <main className="flex-1 min-h-0 overflow-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header + Stats */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <h1 className="text-xl font-semibold">知乎动态</h1>
          {stats && (
            <div className="flex items-center gap-4 text-sm text-zinc-500 dark:text-zinc-400">
              <span>共 {stats.totalFeedItems} 条动态</span>
              {stats.lastFetchTs > 0 && (
                <span>最后抓取: {new Date(stats.lastFetchTs * 1000).toLocaleString('zh-CN')}</span>
              )}
            </div>
          )}
        </div>

        {/* Content type stats */}
        {stats && stats.feedByType.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setTypeFilter('')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full transition-colors cursor-pointer ${
                !typeFilter
                  ? 'bg-blue-500 text-white dark:bg-blue-600'
                  : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-300 dark:hover:bg-zinc-600'
              }`}
            >
              全部
              <span className={!typeFilter ? 'text-blue-200' : 'text-zinc-400 dark:text-zinc-500'}>
                ({stats.totalFeedItems})
              </span>
            </button>
            {stats.feedByType.map((c) => (
              <button
                key={c.targetType}
                type="button"
                onClick={() => setTypeFilter(typeFilter === c.targetType ? '' : c.targetType)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full transition-colors cursor-pointer ${
                  typeFilter === c.targetType
                    ? 'bg-blue-500 text-white dark:bg-blue-600'
                    : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-300 dark:hover:bg-zinc-600'
                }`}
              >
                <FileText className="w-3 h-3" />
                {c.targetType === 'article' ? '文章' : c.targetType === 'answer' ? '回答' : c.targetType}
                <span className={typeFilter === c.targetType ? 'text-blue-200' : 'text-zinc-400 dark:text-zinc-500'}>
                  ({c.count})
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Filters row */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Date preset buttons */}
          <div className="inline-flex items-center gap-0.5 border border-zinc-300 dark:border-zinc-600 rounded-lg overflow-hidden">
            {DATE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setDatePreset(preset)}
                className={`px-2.5 py-1.5 text-xs transition-colors ${
                  datePreset === preset
                    ? 'bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900'
                    : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                {preset}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="flex items-center gap-1">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="搜索标题..."
                className="pl-8 pr-3 py-1.5 text-sm border border-zinc-300 dark:border-zinc-600 rounded-lg bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-blue-500 w-48"
              />
            </div>
            <button
              type="button"
              onClick={handleSearch}
              className="px-2.5 py-1.5 text-xs border border-zinc-300 dark:border-zinc-600 rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
            >
              搜索
            </button>
            {keyword && (
              <button
                type="button"
                onClick={() => { setKeyword(''); setSearchInput(''); }}
                className="px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
              >
                清除
              </button>
            )}
          </div>

          {/* Result count */}
          {!loading && (
            <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-auto">{allContents.length} 条结果</span>
          )}
        </div>

        {/* Loading / Error */}
        {loading && <div className="text-center py-12 text-zinc-400">加载中...</div>}
        {error && <div className="text-center py-12 text-red-500">{error}</div>}

        {/* Empty state */}
        {!loading && !error && allContents.length === 0 && (
          <div className="text-center py-12 text-zinc-400">暂无内容</div>
        )}

        {/* Grouped list */}
        {!loading &&
          !error &&
          groups.map((group) => (
            <div key={group.dateKey} className="space-y-2">
              {/* Date header */}
              <div className="flex items-center gap-2 py-1 sticky top-0 z-10 bg-zinc-100 dark:bg-zinc-900">
                <Calendar className="w-4 h-4 text-zinc-400" />
                <span className="text-sm font-medium text-zinc-600 dark:text-zinc-300">{group.label}</span>
                <span className="text-xs text-zinc-400">({group.items.length})</span>
                <div className="flex-1 border-t border-zinc-200 dark:border-zinc-700" />
              </div>

              {group.items.map((item) => (
                <ContentRow key={`${item.targetType}:${item.targetId}`} item={item} />
              ))}
            </div>
          ))}
      </div>
    </main>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// ContentRow — shows excerpt inline with link to original
// ────────────────────────────────────────────────────────────────────────────

function ContentRow({ item }: { item: ZhihuContentListItem }) {
  const time = new Date(item.createdTime * 1000).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden px-4 py-3 space-y-2">
      {/* Title row */}
      <div className="flex items-center gap-3">
        {/* Type badge */}
        <span
          className={`shrink-0 px-1.5 py-0.5 text-xs rounded font-medium ${
            item.targetType === 'article'
              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400'
              : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
          }`}
        >
          {item.targetType === 'article' ? '文章' : '回答'}
        </span>

        <div className="flex-1 min-w-0">
          <span className="font-medium truncate block">{item.title}</span>
          {item.questionTitle && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
              问题: {item.questionTitle}
            </p>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-3 text-xs text-zinc-400 dark:text-zinc-500">
          <span>{item.authorName}</span>
          <span className="inline-flex items-center gap-0.5">
            <ThumbsUp className="w-3 h-3" />
            {item.voteupCount}
          </span>
          <span className="inline-flex items-center gap-0.5">
            <MessageSquare className="w-3 h-3" />
            {item.commentCount}
          </span>
          <span>{time}</span>
        </div>
      </div>

      {/* Excerpt */}
      {item.excerpt && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed line-clamp-3">
          {item.excerpt}
        </p>
      )}

      {/* Link to original */}
      {item.url && (
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          查看原文 <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </div>
  );
}
