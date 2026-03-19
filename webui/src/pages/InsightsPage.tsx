/**
 * Insights Page - View WeChat article analysis results.
 * Supports filtering by worthReporting, source (dropdown), date range,
 * and groups results by date.
 */

import { Calendar, ChevronDown, ChevronRight, ExternalLink, Filter, Newspaper, Tag } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { getInsight, getInsightStats, listInsights } from '../api';
import type { InsightDetail, InsightListItem, InsightStats } from '../types';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Format ISO date string to YYYY-MM-DD */
function toDateKey(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** Format ISO date string to readable date label */
function toDateLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const key = d.toDateString();
  if (key === today.toDateString()) return '今天';
  if (key === yesterday.toDateString()) return '昨天';
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
}

/** Group insights by date, most recent first */
function groupByDate(items: InsightListItem[]): Array<{ dateKey: string; label: string; items: InsightListItem[] }> {
  const map = new Map<string, InsightListItem[]>();
  for (const item of items) {
    const key = toDateKey(item.analyzedAt);
    const arr = map.get(key);
    if (arr) arr.push(item);
    else map.set(key, [item]);
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([dateKey, groupItems]) => ({
      dateKey,
      label: toDateLabel(groupItems[0].analyzedAt),
      items: groupItems,
    }));
}

// ────────────────────────────────────────────────────────────────────────────
// Date presets
// ────────────────────────────────────────────────────────────────────────────

type DatePreset = '全部' | '今天' | '近3天' | '近7天' | '近30天';
const DATE_PRESETS: DatePreset[] = ['全部', '今天', '近3天', '近7天', '近30天'];

function getPresetStartDate(preset: DatePreset): Date | null {
  if (preset === '全部') return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const days = preset === '今天' ? 0 : preset === '近3天' ? 2 : preset === '近7天' ? 6 : 29;
  now.setDate(now.getDate() - days);
  return now;
}

// ────────────────────────────────────────────────────────────────────────────
// Main Page
// ────────────────────────────────────────────────────────────────────────────

export function InsightsPage() {
  const [allInsights, setAllInsights] = useState<InsightListItem[]>([]);
  const [stats, setStats] = useState<InsightStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [worthOnly, setWorthOnly] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [datePreset, setDatePreset] = useState<DatePreset>('全部');
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false);

  // Detail expansion
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InsightDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Load all data (worthOnly is server-side filter)
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listRes, statsRes] = await Promise.all([listInsights(worthOnly), getInsightStats()]);
      setAllInsights(listRes.insights);
      setStats(statsRes.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [worthOnly]);

  useEffect(() => {
    load();
  }, [load]);

  // Extract unique sources for dropdown
  const sources = useMemo(() => {
    const set = new Map<string, number>();
    for (const i of allInsights) {
      set.set(i.source, (set.get(i.source) ?? 0) + 1);
    }
    return [...set.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  }, [allInsights]);

  // Apply client-side filters (source + date + tag)
  const filtered = useMemo(() => {
    let items = allInsights;
    if (sourceFilter) {
      items = items.filter((i) => i.source === sourceFilter);
    }
    if (tagFilter) {
      items = items.filter((i) => i.categoryTags.includes(tagFilter));
    }
    const startDate = getPresetStartDate(datePreset);
    if (startDate) {
      items = items.filter((i) => new Date(i.analyzedAt) >= startDate);
    }
    return items;
  }, [allInsights, sourceFilter, tagFilter, datePreset]);

  // Group by date
  const groups = useMemo(() => groupByDate(filtered), [filtered]);

  const toggleExpand = useCallback(
    async (id: string) => {
      if (expandedId === id) {
        setExpandedId(null);
        setDetail(null);
        return;
      }
      setExpandedId(id);
      setDetail(null);
      setDetailLoading(true);
      try {
        const res = await getInsight(id);
        setDetail(res.insight);
      } catch {
        // silently fail
      } finally {
        setDetailLoading(false);
      }
    },
    [expandedId],
  );

  // Close source dropdown on outside click
  useEffect(() => {
    if (!sourceDropdownOpen) return;
    const handler = () => setSourceDropdownOpen(false);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [sourceDropdownOpen]);

  return (
    <main className="flex-1 min-h-0 overflow-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header + Stats */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <h1 className="text-xl font-semibold">文章洞察</h1>
          {stats && (
            <div className="flex items-center gap-4 text-sm text-zinc-500 dark:text-zinc-400">
              <span>共 {stats.total} 篇</span>
              <span className="text-green-600 dark:text-green-400">{stats.worthReporting} 值得关注</span>
              <span>{stats.notWorth} 已过滤</span>
            </div>
          )}
        </div>

        {/* Category Tags (clickable) */}
        {stats && stats.byCategory.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {stats.byCategory.slice(0, 20).map((c) => (
              <button
                key={c.tag}
                type="button"
                onClick={() => setTagFilter(tagFilter === c.tag ? '' : c.tag)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full transition-colors cursor-pointer ${
                  tagFilter === c.tag
                    ? 'bg-blue-500 text-white dark:bg-blue-600'
                    : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-300 dark:hover:bg-zinc-600'
                }`}
              >
                <Tag className="w-3 h-3" />
                {c.tag}
                <span className={tagFilter === c.tag ? 'text-blue-200' : 'text-zinc-400 dark:text-zinc-500'}>
                  ({c.count})
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Filters row */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Worth filter */}
          <button
            type="button"
            onClick={() => setWorthOnly(!worthOnly)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-colors ${
              worthOnly
                ? 'border-green-500 bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400 dark:border-green-700'
                : 'border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
            }`}
          >
            <Filter className="w-3.5 h-3.5" />
            {worthOnly ? '仅值得关注' : '显示全部'}
          </button>

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

          {/* Source dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setSourceDropdownOpen(!sourceDropdownOpen);
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                sourceFilter
                  ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-700'
                  : 'border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
              }`}
            >
              <Newspaper className="w-3.5 h-3.5" />
              {sourceFilter || '全部公众号'}
              <ChevronDown className="w-3 h-3" />
            </button>

            {sourceDropdownOpen && (
              // biome-ignore lint/a11y/noStaticElementInteractions: <explanation>
              <div
                className="absolute top-full left-0 mt-1 z-50 w-64 max-h-72 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg"
                onMouseDown={(e) => e.stopPropagation()}
              >
                {/* Clear filter */}
                <button
                  type="button"
                  onClick={() => {
                    setSourceFilter('');
                    setSourceDropdownOpen(false);
                  }}
                  className={`w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors ${
                    !sourceFilter ? 'font-medium text-blue-600 dark:text-blue-400' : ''
                  }`}
                >
                  全部公众号
                </button>
                <div className="border-t border-zinc-100 dark:border-zinc-700" />
                {sources.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => {
                      setSourceFilter(s.name);
                      setSourceDropdownOpen(false);
                    }}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors flex items-center justify-between ${
                      sourceFilter === s.name ? 'font-medium text-blue-600 dark:text-blue-400' : ''
                    }`}
                  >
                    <span className="truncate">{s.name}</span>
                    <span className="shrink-0 text-xs text-zinc-400 ml-2">{s.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Result count */}
          {!loading && (
            <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-auto">{filtered.length} 条结果</span>
          )}
        </div>

        {/* Loading / Error */}
        {loading && <div className="text-center py-12 text-zinc-400">加载中...</div>}
        {error && <div className="text-center py-12 text-red-500">{error}</div>}

        {/* Grouped list */}
        {!loading && !error && filtered.length === 0 && (
          <div className="text-center py-12 text-zinc-400">暂无分析结果</div>
        )}

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
                <InsightRow
                  key={item.articleMsgId}
                  item={item}
                  expanded={expandedId === item.articleMsgId}
                  detail={expandedId === item.articleMsgId ? detail : null}
                  detailLoading={expandedId === item.articleMsgId && detailLoading}
                  onToggle={() => toggleExpand(item.articleMsgId)}
                />
              ))}
            </div>
          ))}
      </div>
    </main>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// InsightRow
// ────────────────────────────────────────────────────────────────────────────

function InsightRow({
  item,
  expanded,
  detail,
  detailLoading,
  onToggle,
}: {
  item: InsightListItem;
  expanded: boolean;
  detail: InsightDetail | null;
  detailLoading: boolean;
  onToggle: () => void;
}) {
  const time = new Date(item.analyzedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
      {/* Summary row */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 shrink-0 text-zinc-400" />
        ) : (
          <ChevronRight className="w-4 h-4 shrink-0 text-zinc-400" />
        )}

        {/* Worth badge */}
        <span
          className={`shrink-0 w-2 h-2 rounded-full ${
            item.worthReporting ? 'bg-green-500' : 'bg-zinc-300 dark:bg-zinc-600'
          }`}
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{item.title}</span>
          </div>
          {item.headline && <p className="text-sm text-zinc-500 dark:text-zinc-400 truncate mt-0.5">{item.headline}</p>}
        </div>

        <div className="shrink-0 flex items-center gap-3 text-xs text-zinc-400 dark:text-zinc-500">
          <span>{item.source}</span>
          <span>{item.itemCount} 条</span>
          <span>{time}</span>
        </div>
      </button>

      {/* Category tags */}
      {!expanded && item.categoryTags.length > 0 && (
        <div className="px-4 pb-2 flex flex-wrap gap-1">
          {item.categoryTags.map((tag) => (
            <span
              key={tag}
              className="px-2 py-0.5 text-xs rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-zinc-200 dark:border-zinc-700 px-4 py-4 bg-zinc-50/50 dark:bg-zinc-800/30">
          {detailLoading && <div className="text-sm text-zinc-400">加载详情...</div>}
          {detail && <InsightDetailView detail={detail} />}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// InsightDetailView
// ────────────────────────────────────────────────────────────────────────────

const IMPORTANCE_COLORS: Record<string, string> = {
  high: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  low: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
};

const TYPE_LABELS: Record<string, string> = {
  fact: '事实',
  opinion: '观点',
  news: '新闻',
  insight: '洞察',
};

function InsightDetailView({ detail }: { detail: InsightDetail }) {
  return (
    <div className="space-y-4">
      {/* Meta */}
      <div className="flex items-center gap-3 text-sm">
        <span className="text-zinc-500 dark:text-zinc-400">来源: {detail.source}</span>
        <span className="text-zinc-500 dark:text-zinc-400">模型: {detail.model}</span>
        {detail.url && (
          <a
            href={detail.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
          >
            原文 <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      {/* Tags */}
      {detail.categoryTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {detail.categoryTags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400"
            >
              <Tag className="w-3 h-3" />
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Items */}
      {detail.items.length > 0 && (
        <div className="space-y-2">
          {detail.items.map((item) => (
            <div
              key={`${item.type}-${item.content.slice(0, 40)}`}
              className="flex gap-3 p-3 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700"
            >
              <div className="shrink-0 flex flex-col items-center gap-1">
                <span
                  className={`px-2 py-0.5 text-xs rounded font-medium ${IMPORTANCE_COLORS[item.importance] ?? IMPORTANCE_COLORS.low}`}
                >
                  {item.importance}
                </span>
                <span className="text-xs text-zinc-400">{TYPE_LABELS[item.type] ?? item.type}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm leading-relaxed">{item.content}</p>
                {item.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {item.tags.map((tag) => (
                      <span
                        key={tag}
                        className="px-1.5 py-0.5 text-xs rounded bg-zinc-100 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {detail.items.length === 0 && <p className="text-sm text-zinc-400">无提取内容（可能文章内容不足）</p>}
    </div>
  );
}
