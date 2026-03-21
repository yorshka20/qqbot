/**
 * Browse View — search, filter, and browse moments with tags and timeline chart.
 */

import { Calendar, Clock, Hash, Loader2, Search, Tag, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { listMoments, searchMoments } from '../api'
import { type DateFilterValue, MomentsDateFilter } from './MomentsDateFilter'
import { useChartTooltipStyle } from './MomentsShared'
import { getOutputBase } from '../config'
import type { MomentItem, MomentsStats } from '../types'

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function formatTime(ct: string): string {
  if (!ct) return '未知时间'
  return ct.slice(0, 16)
}

function toDateLabel(ct: string): string {
  if (!ct) return '未知'
  const d = new Date(ct.replace(' ', 'T'))
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)

  const key = d.toDateString()
  if (key === today.toDateString()) return '今天'
  if (key === yesterday.toDateString()) return '昨天'
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })
}

function groupByDate(items: MomentItem[]): Array<{ dateKey: string; label: string; items: MomentItem[] }> {
  const map = new Map<string, MomentItem[]>()
  for (const item of items) {
    const key = item.createTime.slice(0, 10)
    const arr = map.get(key)
    if (arr) arr.push(item)
    else map.set(key, [item])
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([dateKey, groupItems]) => ({
      dateKey,
      label: toDateLabel(groupItems[0].createTime),
      items: groupItems,
    }))
}

// ────────────────────────────────────────────────────────────────────────────
// BrowseView
// ────────────────────────────────────────────────────────────────────────────

export function BrowseView({ stats, isDark }: { stats: MomentsStats | null; isDark: boolean }) {
  const [moments, setMoments] = useState<MomentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nextOffset, setNextOffset] = useState<string | number | null>(null)
  const [tagFilter, setTagFilter] = useState('')
  const [dateFilter, setDateFilter] = useState<DateFilterValue>({ mode: 'day', value: '' })
  const [searchQuery, setSearchQuery] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [searchResults, setSearchResults] = useState<MomentItem[] | null>(null)
  const [searching, setSearching] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [expandedId, setExpandedId] = useState<string | number | null>(null)
  const tooltipStyle = useChartTooltipStyle(isDark)

  const loadMoments = useCallback(
    async (append = false) => {
      if (!append) {
        setLoading(true)
        setError(null)
      } else {
        setLoadingMore(true)
      }
      try {
        const dateOpts: Record<string, string> = {}
        if (dateFilter.value) {
          if (dateFilter.mode === 'day') dateOpts.date = dateFilter.value
          else if (dateFilter.mode === 'month') dateOpts.month = dateFilter.value
          else if (dateFilter.mode === 'year') dateOpts.year = dateFilter.value
        }
        const res = await listMoments({
          tag: tagFilter || undefined,
          ...dateOpts,
          offset: append ? (nextOffset as string | undefined) : undefined,
          limit: 50,
        })
        if (append) {
          setMoments((prev) => [...prev, ...res.moments])
        } else {
          setMoments(res.moments)
        }
        setNextOffset(res.nextOffset)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [tagFilter, dateFilter.mode, dateFilter.value, nextOffset],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - reload on filter change
  useEffect(() => {
    loadMoments(false)
  }, [tagFilter, dateFilter.mode, dateFilter.value])

  const doSearch = useCallback(async () => {
    const q = searchInput.trim()
    if (!q) {
      setSearchResults(null)
      setSearchQuery('')
      return
    }
    setSearching(true)
    setSearchQuery(q)
    try {
      const res = await searchMoments({ q, limit: 30 })
      setSearchResults(res.moments)
    } catch {
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [searchInput])

  const clearSearch = useCallback(() => {
    setSearchInput('')
    setSearchQuery('')
    setSearchResults(null)
    searchInputRef.current?.focus()
  }, [])

  const displayItems = searchResults ?? moments
  const isSearchMode = searchResults != null
  const groups = useMemo(() => groupByDate(displayItems), [displayItems])

  return (
    <>
      {/* Search bar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doSearch()}
            placeholder="语义搜索朋友圈内容..."
            className="w-full pl-9 pr-9 py-2 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          {searchInput && (
            <button
              type="button"
              onClick={clearSearch}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={doSearch}
          disabled={searching || !searchInput.trim()}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
        >
          {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : '搜索'}
        </button>
      </div>

      {isSearchMode && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-zinc-500 dark:text-zinc-400">
            搜索「{searchQuery}」找到 {searchResults?.length ?? 0} 条结果
          </span>
          <button type="button" onClick={clearSearch} className="text-blue-600 dark:text-blue-400 hover:underline text-sm">
            清除搜索
          </button>
        </div>
      )}

      {/* Timeline chart */}
      {!isSearchMode && stats && stats.monthlyCount.length > 0 && (
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 bg-white dark:bg-zinc-800">
          <h2 className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-3 flex items-center gap-1.5">
            <Clock className="w-4 h-4" />
            发布趋势
          </h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={stats.monthlyCount}>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#3f3f46' : '#e4e4e7'} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: isDark ? '#a1a1aa' : '#71717a' }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 11, fill: isDark ? '#a1a1aa' : '#71717a' }} width={35} />
              <Tooltip contentStyle={tooltipStyle} formatter={(value) => [`${value} 条`, '发布量']} />
              <Bar dataKey="count" fill={isDark ? '#3b82f6' : '#2563eb'} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Tag cloud */}
      {!isSearchMode && stats && stats.topTags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tagFilter && (
            <button
              type="button"
              onClick={() => setTagFilter('')}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/60 transition-colors"
            >
              清除筛选
            </button>
          )}
          {stats.topTags.map((t) => (
            <button
              key={t.tag}
              type="button"
              onClick={() => setTagFilter(tagFilter === t.tag ? '' : t.tag)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full transition-colors cursor-pointer ${
                tagFilter === t.tag
                  ? 'bg-blue-500 text-white dark:bg-blue-600'
                  : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-300 dark:hover:bg-zinc-600'
              }`}
            >
              <Tag className="w-3 h-3" />
              {t.tag}
              <span className={tagFilter === t.tag ? 'text-blue-200' : 'text-zinc-400 dark:text-zinc-500'}>({t.count})</span>
            </button>
          ))}
        </div>
      )}

      {/* Filters row */}
      {!isSearchMode && (
        <div className="flex items-center gap-2 flex-wrap">
          <MomentsDateFilter value={dateFilter} onChange={setDateFilter} />
          {!loading && (
            <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-auto">{displayItems.length} 条结果</span>
          )}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12 text-zinc-400 gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          加载中...
        </div>
      )}
      {error && <div className="text-center py-12 text-red-500">{error}</div>}

      {!loading && !error && moments.length === 0 && <div className="text-center py-12 text-zinc-400">暂无数据</div>}

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
              <MomentRow
                key={String(item.id)}
                item={item}
                expanded={expandedId === item.id}
                onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                onTagClick={(tag) => setTagFilter(tag)}
              />
            ))}
          </div>
        ))}

      {!loading && !isSearchMode && nextOffset != null && (
        <div className="text-center py-4">
          <button
            type="button"
            onClick={() => loadMoments(true)}
            disabled={loadingMore}
            className="px-4 py-2 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
          >
            {loadingMore ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                加载中...
              </span>
            ) : (
              '加载更多'
            )}
          </button>
        </div>
      )}
    </>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// MomentRow
// ────────────────────────────────────────────────────────────────────────────

function MomentRow({
  item,
  expanded,
  onToggle,
  onTagClick,
}: {
  item: MomentItem
  expanded: boolean
  onToggle: () => void
  onTagClick: (tag: string) => void
}) {
  const contentPreview = expanded ? item.content : item.content.slice(0, 200)
  const needsTruncation = !expanded && item.content.length > 200

  return (
    <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden bg-white dark:bg-zinc-800/50">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: toggle expand */}
      {/* biome-ignore lint/a11y/useSemanticElements: toggle expand */}
      <div
        role="button"
        tabIndex={0}
        className="px-4 py-3 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/80 transition-colors"
        onClick={onToggle}
        onKeyDown={(e) => e.key === 'Enter' && onToggle()}
      >
        <div className="flex items-center gap-3 text-xs text-zinc-400 dark:text-zinc-500 mb-1.5">
          <span className="inline-flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatTime(item.createTime)}
          </span>
          {item.score != null && (
            <span className="text-blue-500 dark:text-blue-400 font-medium">{item.score.toFixed(3)}</span>
          )}
          {item.mediasCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <Hash className="w-3 h-3" />
              {item.mediasCount} 张图片
            </span>
          )}
          {item.summary && <span className="text-zinc-500 dark:text-zinc-400 truncate flex-1">{item.summary}</span>}
        </div>

        <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
          {contentPreview}
          {needsTruncation && <span className="text-zinc-400">...</span>}
        </p>

        {item.imagePaths.length > 0 && (
          <div
            className={`mt-2 grid gap-1.5 ${item.imagePaths.length === 1 ? 'grid-cols-1 max-w-xs' : item.imagePaths.length <= 4 ? 'grid-cols-2 max-w-md' : 'grid-cols-3 max-w-lg'}`}
          >
            {item.imagePaths.map((p) => {
              const url = `${getOutputBase()}/${p.replace(/^output\//, '')}`
              return (
                <a key={p} href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                  <img
                    src={url}
                    alt=""
                    loading="lazy"
                    className="w-full aspect-square object-cover rounded border border-zinc-200 dark:border-zinc-700 hover:opacity-90 transition-opacity"
                  />
                </a>
              )
            })}
          </div>
        )}
      </div>

      {item.tags.length > 0 && (
        <div className="px-4 pb-2.5 flex flex-wrap gap-1">
          {item.tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onTagClick(tag)
              }}
              className="px-2 py-0.5 text-xs rounded bg-zinc-100 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400 hover:bg-blue-100 dark:hover:bg-blue-900/40 hover:text-blue-700 dark:hover:text-blue-400 transition-colors"
            >
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
