/**
 * Interest Evolution View — tag × month heatmap showing topic trends over time.
 * Layout: months as rows (vertical), tags as columns (horizontal), tag labels sticky at top.
 */

import { TrendingUp } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { getMomentsInterestEvolution } from '../api';
import type { InterestEvolutionResponse } from '../types';
import { EmptyState, LoadingSpinner } from './MomentsShared';

const HEATMAP_COLORS = ['#f4f4f5', '#dbeafe', '#93c5fd', '#3b82f6', '#1d4ed8', '#1e3a8a'];
const HEATMAP_COLORS_DARK = ['#27272a', '#1e3a5f', '#1e40af', '#2563eb', '#3b82f6', '#60a5fa'];

export function InterestEvolutionView({ isDark }: { isDark: boolean }) {
  const [data, setData] = useState<InterestEvolutionResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getMomentsInterestEvolution()
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const { countMap, maxCount, sortedTags, colors } = useMemo(() => {
    if (!data) return { countMap: new Map(), maxCount: 0, sortedTags: [] as string[], colors: HEATMAP_COLORS };
    const cm = new Map<string, number>();
    let mc = 0;
    for (const h of data.heatmap) {
      cm.set(`${h.tag}:${h.month}`, h.count);
      if (h.count > mc) mc = h.count;
    }
    const tagTotals = new Map<string, number>();
    for (const h of data.heatmap) {
      tagTotals.set(h.tag, (tagTotals.get(h.tag) ?? 0) + h.count);
    }
    return {
      countMap: cm,
      maxCount: mc,
      sortedTags: [...tagTotals.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t),
      colors: isDark ? HEATMAP_COLORS_DARK : HEATMAP_COLORS,
    };
  }, [data, isDark]);

  if (loading) return <LoadingSpinner />;
  if (!data || data.heatmap.length === 0) return <EmptyState text="暂无标签数据，请先运行标签批处理脚本" />;

  const displayTags = sortedTags.slice(0, 25);

  function getColor(count: number): string {
    if (count === 0) return colors[0];
    const level = Math.min(Math.ceil((count / maxCount) * (colors.length - 1)), colors.length - 1);
    return colors[level];
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-600 dark:text-zinc-300 flex items-center gap-1.5">
          <TrendingUp className="w-4 h-4" />
          兴趣演化热力图
        </h2>
        {/* Legend */}
        <div className="flex items-center gap-1.5 text-xs text-zinc-400">
          <span>少</span>
          {colors.map((c) => (
            <div key={c} className="w-3 h-3 rounded-sm" style={{ backgroundColor: c }} />
          ))}
          <span>多</span>
        </div>
      </div>

      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800">
        {/* Transposed layout: tags as columns, months as rows */}
        <div className="overflow-y-auto max-h-[70vh]">
          <table className="w-full border-collapse" style={{ tableLayout: 'fixed' }}>
            {/* Tag header — sticky at top */}
            <thead className="sticky top-0 z-10">
              <tr className="bg-white dark:bg-zinc-800">
                {/* Month column header */}
                <th className="text-left text-xs text-zinc-400 dark:text-zinc-500 px-2 py-1.5 w-16 bg-white dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
                  月份
                </th>
                {displayTags.map((tag) => (
                  <th
                    key={tag}
                    className="text-center text-xs text-zinc-600 dark:text-zinc-400 px-0.5 py-1.5 bg-white dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700"
                  >
                    <span
                      className="writing-vertical"
                      style={{
                        writingMode: 'vertical-rl',
                        textOrientation: 'mixed',
                        display: 'inline-block',
                        maxHeight: 56,
                        overflow: 'hidden',
                      }}
                    >
                      {tag}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            {/* Month rows */}
            <tbody>
              {data.months.map((month) => (
                <tr key={month} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/80">
                  <td className="text-xs text-zinc-500 dark:text-zinc-400 px-2 py-0 whitespace-nowrap">{month}</td>
                  {displayTags.map((tag) => {
                    const count = countMap.get(`${tag}:${month}`) ?? 0;
                    return (
                      <td key={tag} className="p-0.5">
                        <div
                          className="w-full aspect-square rounded-sm cursor-default"
                          style={{ backgroundColor: getColor(count), minHeight: 10 }}
                          title={`${tag} ${month}: ${count} 条`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
