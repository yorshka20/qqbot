/**
 * Zhihu page (route entry) — browse Zhihu feed items with excerpts and links to originals.
 */

import { Calendar, FileText, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { getZhihuStats, listZhihuContents } from '../../api';
import type { ZhihuContentListItem, ZhihuPageStats } from '../../types';
import { groupByZhLocaleDate } from '../../utils/zhLocaleDateGroups';
import { ZhihuContentRow } from './components/ZhihuContentRow';
import { getZhihuPresetSinceTs, ZHIHU_DATE_PRESETS, type ZhihuDatePreset } from './utils';

export function ZhihuPage() {
  const [allContents, setAllContents] = useState<ZhihuContentListItem[]>([]);
  const [stats, setStats] = useState<ZhihuPageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [typeFilter, setTypeFilter] = useState<string>('');
  const [datePreset, setDatePreset] = useState<ZhihuDatePreset>('全部');
  const [keyword, setKeyword] = useState('');
  const [searchInput, setSearchInput] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sinceTs = getZhihuPresetSinceTs(datePreset);
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

  const groups = useMemo(() => groupByZhLocaleDate(allContents, (i) => new Date(i.createdTime * 1000)), [allContents]);

  const handleSearch = useCallback(() => {
    setKeyword(searchInput.trim());
  }, [searchInput]);

  return (
    <main className="flex-1 min-h-0 overflow-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
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

        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex items-center gap-0.5 border border-zinc-300 dark:border-zinc-600 rounded-lg overflow-hidden">
            {ZHIHU_DATE_PRESETS.map((preset) => (
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
                onClick={() => {
                  setKeyword('');
                  setSearchInput('');
                }}
                className="px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
              >
                清除
              </button>
            )}
          </div>

          {!loading && (
            <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-auto">{allContents.length} 条结果</span>
          )}
        </div>

        {loading && <div className="text-center py-12 text-zinc-400">加载中...</div>}
        {error && <div className="text-center py-12 text-red-500">{error}</div>}

        {!loading && !error && allContents.length === 0 && (
          <div className="text-center py-12 text-zinc-400">暂无内容</div>
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
                <ZhihuContentRow key={`${item.targetType}:${item.targetId}`} item={item} />
              ))}
            </div>
          ))}
      </div>
    </main>
  );
}
