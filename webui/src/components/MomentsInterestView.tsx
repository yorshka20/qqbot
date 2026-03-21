/**
 * Interest Evolution View — tag × month heatmap showing topic trends over time.
 */

import { TrendingUp } from 'lucide-react'
import { useEffect, useState } from 'react'

import { getMomentsInterestEvolution } from '../api'
import { EmptyState, LoadingSpinner } from './MomentsShared'
import type { InterestEvolutionResponse } from '../types'

const HEATMAP_COLORS = ['#f4f4f5', '#dbeafe', '#93c5fd', '#3b82f6', '#1d4ed8', '#1e3a8a']
const HEATMAP_COLORS_DARK = ['#27272a', '#1e3a5f', '#1e40af', '#2563eb', '#3b82f6', '#60a5fa']

export function InterestEvolutionView({ isDark }: { isDark: boolean }) {
  const [data, setData] = useState<InterestEvolutionResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    getMomentsInterestEvolution()
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSpinner />
  if (!data || data.heatmap.length === 0) return <EmptyState text="暂无标签数据，请先运行标签批处理脚本" />

  const countMap = new Map<string, number>()
  let maxCount = 0
  for (const h of data.heatmap) {
    const key = `${h.tag}:${h.month}`
    countMap.set(key, h.count)
    if (h.count > maxCount) maxCount = h.count
  }

  const tagTotals = new Map<string, number>()
  for (const h of data.heatmap) {
    tagTotals.set(h.tag, (tagTotals.get(h.tag) ?? 0) + h.count)
  }
  const sortedTags = [...tagTotals.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
  const colors = isDark ? HEATMAP_COLORS_DARK : HEATMAP_COLORS

  function getColor(count: number): string {
    if (count === 0) return colors[0]
    const level = Math.min(Math.ceil((count / maxCount) * (colors.length - 1)), colors.length - 1)
    return colors[level]
  }

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-zinc-600 dark:text-zinc-300 flex items-center gap-1.5">
        <TrendingUp className="w-4 h-4" />
        兴趣演化热力图
      </h2>
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 bg-white dark:bg-zinc-800 overflow-x-auto">
        <div className="min-w-[600px]">
          {/* Month header */}
          <div className="flex">
            <div className="w-20 shrink-0" />
            {data.months.map((m) => (
              <div key={m} className="flex-1 text-center text-xs text-zinc-400 dark:text-zinc-500 pb-2" style={{ minWidth: 32 }}>
                {m.slice(5)}
              </div>
            ))}
          </div>
          {/* Tag rows */}
          {sortedTags.slice(0, 20).map((tag) => (
            <div key={tag} className="flex items-center">
              <div className="w-20 shrink-0 text-xs text-zinc-600 dark:text-zinc-400 truncate pr-2 py-0.5">{tag}</div>
              {data.months.map((month) => {
                const count = countMap.get(`${tag}:${month}`) ?? 0
                return (
                  <div
                    key={month}
                    className="flex-1 aspect-square m-0.5 rounded-sm cursor-default"
                    style={{ backgroundColor: getColor(count), minWidth: 28, maxWidth: 40 }}
                    title={`${tag} ${month}: ${count} 条`}
                  />
                )
              })}
            </div>
          ))}
          {/* Legend */}
          <div className="flex items-center gap-2 mt-3 text-xs text-zinc-400">
            <span>少</span>
            {colors.map((c) => (
              <div key={c} className="w-4 h-4 rounded-sm" style={{ backgroundColor: c }} />
            ))}
            <span>多</span>
          </div>
        </div>
      </div>
    </div>
  )
}
