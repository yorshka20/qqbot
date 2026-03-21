/**
 * Sentiment View — emotion analysis with trend charts and distribution.
 */

import { Smile } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { getMomentsSentimentTrend } from '../api'
import { EmptyState, LoadingSpinner, useChartTooltipStyle } from './MomentsShared'
import type { SentimentTrendResponse } from '../types'

const SENTIMENT_COLORS: Record<string, string> = {
  positive: '#22c55e',
  neutral: '#a1a1aa',
  negative: '#ef4444',
  mixed: '#f59e0b',
}

const SENTIMENT_LABELS: Record<string, string> = {
  positive: '积极',
  neutral: '中性',
  negative: '消极',
  mixed: '混合',
}

export function SentimentView({ isDark }: { isDark: boolean }) {
  const [data, setData] = useState<SentimentTrendResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const tooltipStyle = useChartTooltipStyle(isDark)

  useEffect(() => {
    setLoading(true)
    getMomentsSentimentTrend()
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSpinner />
  if (!data || data.analyzedCount === 0) {
    return <EmptyState text="暂无情绪分析数据，请先运行: bun scripts/moments/moments-sentiment.ts" />
  }

  const { overall } = data

  return (
    <div className="space-y-6">
      <h2 className="text-sm font-medium text-zinc-600 dark:text-zinc-300 flex items-center gap-1.5">
        <Smile className="w-4 h-4" />
        情绪分析
        <span className="text-xs text-zinc-400 ml-2">({data.analyzedCount} 条已分析)</span>
      </h2>

      {/* Overall distribution */}
      <div className="grid grid-cols-4 gap-3">
        {(['positive', 'neutral', 'negative', 'mixed'] as const).map((s) => {
          const count = overall[s]
          const pct = overall.total > 0 ? ((count / overall.total) * 100).toFixed(1) : '0'
          return (
            <div
              key={s}
              className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-3 bg-white dark:bg-zinc-800 text-center"
            >
              <div className="text-2xl font-semibold" style={{ color: SENTIMENT_COLORS[s] }}>
                {count}
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                {SENTIMENT_LABELS[s]} ({pct}%)
              </div>
            </div>
          )
        })}
      </div>

      {/* Score trend line chart */}
      {data.trend.length > 0 && (
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 bg-white dark:bg-zinc-800">
          <h3 className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-3">情绪得分趋势</h3>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={data.trend}>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#3f3f46' : '#e4e4e7'} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: isDark ? '#a1a1aa' : '#71717a' }} interval="preserveStartEnd" />
              <YAxis domain={[-1, 1]} tick={{ fontSize: 11, fill: isDark ? '#a1a1aa' : '#71717a' }} width={35} />
              <Tooltip contentStyle={tooltipStyle} formatter={(value) => [`${Number(value).toFixed(2)}`, '平均得分']} />
              <Line type="monotone" dataKey="avgScore" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Stacked bar distribution */}
      {data.trend.length > 0 && (
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 bg-white dark:bg-zinc-800">
          <h3 className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-3">月度情绪分布</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data.trend}>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#3f3f46' : '#e4e4e7'} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: isDark ? '#a1a1aa' : '#71717a' }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 11, fill: isDark ? '#a1a1aa' : '#71717a' }} width={35} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend formatter={(value) => SENTIMENT_LABELS[value] ?? value} />
              <Bar dataKey="positive" stackId="a" fill={SENTIMENT_COLORS.positive} name="positive" />
              <Bar dataKey="neutral" stackId="a" fill={SENTIMENT_COLORS.neutral} name="neutral" />
              <Bar dataKey="mixed" stackId="a" fill={SENTIMENT_COLORS.mixed} name="mixed" />
              <Bar dataKey="negative" stackId="a" fill={SENTIMENT_COLORS.negative} name="negative" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
