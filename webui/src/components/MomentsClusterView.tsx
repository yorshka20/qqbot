/**
 * Cluster View — content clustering results visualization.
 */

import { Layers } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { getMomentsClusters } from '../api'
import type { ClustersResponse } from '../types'
import { EmptyState, LoadingSpinner, useChartTooltipStyle } from './MomentsShared'

const CLUSTER_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6366f1',
  '#84cc16', '#e11d48', '#0ea5e9', '#a855f7', '#10b981',
  '#fbbf24', '#f43f5e', '#2dd4bf', '#818cf8', '#fb923c',
  '#4ade80', '#f472b6', '#38bdf8', '#c084fc', '#34d399',
]

export function ClusterView({ isDark }: { isDark: boolean }) {
  const [data, setData] = useState<ClustersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const tooltipStyle = useChartTooltipStyle(isDark)

  useEffect(() => {
    setLoading(true)
    getMomentsClusters()
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSpinner />
  if (!data || data.clusteredCount === 0) {
    return <EmptyState text="暂无聚类数据，请先运行: python scripts/clustering/moments_cluster.py" />
  }

  const { clusters } = data
  const maxCount = clusters[0]?.count ?? 1

  return (
    <div className="space-y-6">
      <h2 className="text-sm font-medium text-zinc-600 dark:text-zinc-300 flex items-center gap-1.5">
        <Layers className="w-4 h-4" />
        内容聚类
        <span className="text-xs text-zinc-400 ml-2">({data.clusteredCount} 条已聚类，{clusters.length} 个类别)</span>
      </h2>

      {/* Bar chart */}
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 bg-white dark:bg-zinc-800">
        <h3 className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-3">聚类分布</h3>
        <ResponsiveContainer width="100%" height={Math.max(200, clusters.length * 32)}>
          <BarChart data={clusters} layout="vertical" margin={{ left: 80 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#3f3f46' : '#e4e4e7'} />
            <XAxis type="number" tick={{ fontSize: 11, fill: isDark ? '#a1a1aa' : '#71717a' }} />
            <YAxis
              type="category"
              dataKey="label"
              tick={{ fontSize: 12, fill: isDark ? '#d4d4d8' : '#3f3f46' }}
              width={80}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value) => [`${value} 条`, '数量']}
            />
            <Bar dataKey="count" radius={[0, 4, 4, 0]}>
              {clusters.map((entry, i) => (
                <Cell key={entry.clusterId} fill={CLUSTER_COLORS[i % CLUSTER_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Cluster cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {clusters.map((c, i) => {
          const color = CLUSTER_COLORS[i % CLUSTER_COLORS.length]
          const pct = data.clusteredCount > 0 ? ((c.count / data.clusteredCount) * 100).toFixed(1) : '0'
          const barWidth = Math.max(4, (c.count / maxCount) * 100)
          return (
            <div
              key={c.clusterId}
              className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-3 bg-white dark:bg-zinc-800"
            >
              <div className="flex items-center gap-2 mb-2">
                <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: color }} />
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">{c.label}</span>
              </div>
              <div className="h-2 bg-zinc-100 dark:bg-zinc-700 rounded-full overflow-hidden mb-1.5">
                <div className="h-full rounded-full" style={{ width: `${barWidth}%`, backgroundColor: color }} />
              </div>
              <div className="text-xs text-zinc-400">
                {c.count} 条 ({pct}%)
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
