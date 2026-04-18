/**
 * Insights page (route entry) — WeChat article analysis results.
 */

import { Calendar, ChevronDown, Filter, Newspaper, Tag } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { getInsight, getInsightStats, listInsights } from '../../api';
import type { InsightDetail, InsightListItem, InsightStats } from '../../types';
import { groupByZhLocaleDate } from '../../utils/zhLocaleDateGroups';
import { InsightRow } from './components/InsightRow';
import { getInsightPresetStartDate, INSIGHT_DATE_PRESETS, type InsightDatePreset } from './utils';

export function InsightsPage() {
  const [allInsights, setAllInsights] = useState<InsightListItem[]>([]);
  const [stats, setStats] = useState<InsightStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [worthOnly, setWorthOnly] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [datePreset, setDatePreset] = useState<InsightDatePreset>('全部');
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InsightDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

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

  const sources = useMemo(() => {
    const set = new Map<string, number>();
    for (const i of allInsights) {
      set.set(i.source, (set.get(i.source) ?? 0) + 1);
    }
    return [...set.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  }, [allInsights]);

  const filtered = useMemo(() => {
    let items = allInsights;
    if (sourceFilter) {
      items = items.filter((i) => i.source === sourceFilter);
    }
    if (tagFilter) {
      items = items.filter((i) => i.categoryTags.includes(tagFilter));
    }
    const startDate = getInsightPresetStartDate(datePreset);
    if (startDate) {
      items = items.filter((i) => new Date(i.analyzedAt) >= startDate);
    }
    return items;
  }, [allInsights, sourceFilter, tagFilter, datePreset]);

  const groups = useMemo(() => groupByZhLocaleDate(filtered, (i) => new Date(i.analyzedAt)), [filtered]);

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

  useEffect(() => {
    if (!sourceDropdownOpen) return;
    const handler = () => setSourceDropdownOpen(false);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [sourceDropdownOpen]);

  return (
    <main className="flex-1 min-h-0 overflow-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
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

        <div className="flex items-center gap-2 flex-wrap">
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

          <div className="inline-flex items-center gap-0.5 border border-zinc-300 dark:border-zinc-600 rounded-lg overflow-hidden">
            {INSIGHT_DATE_PRESETS.map((preset) => (
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

          {!loading && (
            <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-auto">{filtered.length} 条结果</span>
          )}
        </div>

        {loading && <div className="text-center py-12 text-zinc-400">加载中...</div>}
        {error && <div className="text-center py-12 text-red-500">{error}</div>}

        {!loading && !error && filtered.length === 0 && (
          <div className="text-center py-12 text-zinc-400">暂无分析结果</div>
        )}

        {!loading &&
          !error &&
          groups.map((group) => (
            <div key={group.dateKey} className="space-y-2">
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
