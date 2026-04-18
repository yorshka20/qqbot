/**
 * Behavior View — posting patterns: hour/day distribution, gap stats, monthly frequency.
 */

import { Activity } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { getMomentsBehavior } from '../api';
import type { BehaviorResponse } from '../types';
import { EmptyState, LoadingSpinner, useChartTooltipStyle } from './MomentsShared';

export function BehaviorView({ isDark }: { isDark: boolean }) {
  const [data, setData] = useState<BehaviorResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const tooltipStyle = useChartTooltipStyle(isDark);

  useEffect(() => {
    setLoading(true);
    getMomentsBehavior()
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;
  if (!data) return <EmptyState text="无法加载行为数据" />;

  return (
    <div className="space-y-6">
      <h2 className="text-sm font-medium text-zinc-600 dark:text-zinc-300 flex items-center gap-1.5">
        <Activity className="w-4 h-4" />
        发布行为模式
      </h2>

      {/* Gap stats summary */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: '平均间隔', value: `${data.gapStats.avgDays} 天` },
          { label: '中位数间隔', value: `${data.gapStats.medianDays} 天` },
          { label: '最长沉默', value: `${data.gapStats.maxDays} 天` },
          { label: '最短间隔', value: `${data.gapStats.minDays} 天` },
        ].map((s) => (
          <div
            key={s.label}
            className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-3 bg-white dark:bg-zinc-800 text-center"
          >
            <div className="text-xl font-semibold text-zinc-800 dark:text-zinc-200">{s.value}</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Hour of day distribution */}
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 bg-white dark:bg-zinc-800">
        <h3 className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-3">每日时段分布</h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data.hourDistribution}>
            <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#3f3f46' : '#e4e4e7'} />
            <XAxis
              dataKey="hour"
              tick={{ fontSize: 11, fill: isDark ? '#a1a1aa' : '#71717a' }}
              tickFormatter={(h) => `${h}时`}
            />
            <YAxis tick={{ fontSize: 11, fill: isDark ? '#a1a1aa' : '#71717a' }} width={35} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value) => [`${value} 条`, '发布量']}
              labelFormatter={(h) => `${h}:00 - ${h}:59`}
            />
            <Bar dataKey="count" radius={[2, 2, 0, 0]}>
              {data.hourDistribution.map((entry) => (
                <Cell
                  key={entry.hour}
                  fill={
                    entry.hour >= 22 || entry.hour < 6
                      ? isDark
                        ? '#8b5cf6'
                        : '#7c3aed'
                      : isDark
                        ? '#3b82f6'
                        : '#2563eb'
                  }
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Day of week distribution */}
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 bg-white dark:bg-zinc-800">
        <h3 className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-3">周几分布</h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data.dayOfWeekDistribution}>
            <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#3f3f46' : '#e4e4e7'} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: isDark ? '#a1a1aa' : '#71717a' }} />
            <YAxis tick={{ fontSize: 11, fill: isDark ? '#a1a1aa' : '#71717a' }} width={35} />
            <Tooltip contentStyle={tooltipStyle} formatter={(value) => [`${value} 条`, '发布量']} />
            <Bar dataKey="count" radius={[2, 2, 0, 0]}>
              {data.dayOfWeekDistribution.map((entry) => (
                <Cell
                  key={entry.day}
                  fill={
                    entry.day === 0 || entry.day === 6
                      ? isDark
                        ? '#f59e0b'
                        : '#d97706'
                      : isDark
                        ? '#3b82f6'
                        : '#2563eb'
                  }
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Monthly frequency */}
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 bg-white dark:bg-zinc-800">
        <h3 className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-3">月度发布频率</h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data.monthlyFrequency}>
            <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#3f3f46' : '#e4e4e7'} />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 11, fill: isDark ? '#a1a1aa' : '#71717a' }}
              interval="preserveStartEnd"
            />
            <YAxis tick={{ fontSize: 11, fill: isDark ? '#a1a1aa' : '#71717a' }} width={35} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value, name) => {
                if (name === 'count') return [`${value} 条`, '发布量'];
                return [`${value} 天`, '平均间隔'];
              }}
            />
            <Bar dataKey="count" fill={isDark ? '#3b82f6' : '#2563eb'} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
