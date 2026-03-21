/**
 * Moments Page - View and explore WeChat moments data with multiple analysis modes.
 */

import { Activity, Clock, Smile, TrendingUp, Users } from 'lucide-react'
import { useEffect, useState } from 'react'

import { getMomentsStats } from '../api'
import { BehaviorView } from '../components/MomentsBehaviorView'
import { BrowseView } from '../components/MomentsBrowseView'
import { EntitiesView } from '../components/MomentsEntitiesView'
import { InterestEvolutionView } from '../components/MomentsInterestView'
import { SentimentView } from '../components/MomentsSentimentView'
import { useDarkMode } from '../components/MomentsShared'
import type { MomentsStats } from '../types'

// ────────────────────────────────────────────────────────────────────────────
// View modes
// ────────────────────────────────────────────────────────────────────────────

type ViewMode = 'browse' | 'interest' | 'sentiment' | 'entities' | 'behavior'

const VIEW_MODES: Array<{ key: ViewMode; label: string; icon: typeof Clock }> = [
  { key: 'browse', label: '浏览', icon: Clock },
  { key: 'interest', label: '兴趣演化', icon: TrendingUp },
  { key: 'sentiment', label: '情绪分析', icon: Smile },
  { key: 'entities', label: '实体图谱', icon: Users },
  { key: 'behavior', label: '行为模式', icon: Activity },
]

// ────────────────────────────────────────────────────────────────────────────
// Main Page
// ────────────────────────────────────────────────────────────────────────────

export function MomentsPage() {
  const [viewMode, setViewMode] = useState<ViewMode>('browse')
  const [stats, setStats] = useState<MomentsStats | null>(null)
  const isDark = useDarkMode()

  useEffect(() => {
    getMomentsStats()
      .then((res) => setStats(res.stats))
      .catch(() => {})
  }, [])

  return (
    <main className="flex-1 min-h-0 overflow-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header + Stats */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <h1 className="text-xl font-semibold">朋友圈</h1>
          {stats && (
            <div className="flex items-center gap-4 text-sm text-zinc-500 dark:text-zinc-400">
              <span>共 {stats.total} 条</span>
              <span className="text-green-600 dark:text-green-400">{stats.tagged} 已标签</span>
              <span>{stats.untagged} 未标签</span>
              {stats.timeRange && (
                <span className="text-zinc-400 dark:text-zinc-500">
                  {stats.timeRange.earliest.slice(0, 10)} ~ {stats.timeRange.latest.slice(0, 10)}
                </span>
              )}
            </div>
          )}
        </div>

        {/* View mode switcher */}
        <div className="flex items-center gap-1 p-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg w-fit">
          {VIEW_MODES.map((m) => {
            const Icon = m.icon
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => setViewMode(m.key)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors ${
                  viewMode === m.key
                    ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {m.label}
              </button>
            )
          })}
        </div>

        {/* View content */}
        {viewMode === 'browse' && <BrowseView stats={stats} isDark={isDark} />}
        {viewMode === 'interest' && <InterestEvolutionView isDark={isDark} />}
        {viewMode === 'sentiment' && <SentimentView isDark={isDark} />}
        {viewMode === 'entities' && <EntitiesView />}
        {viewMode === 'behavior' && <BehaviorView isDark={isDark} />}
      </div>
    </main>
  )
}
