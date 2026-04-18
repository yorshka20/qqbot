import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { DailyStats } from '../../../types';
import { DAILY_STATS_PIE_COLORS } from '../utils';

export function DailyStatsCharts({ stats }: { stats: DailyStats }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="bg-white dark:bg-zinc-800 rounded-xl p-4 border border-zinc-200 dark:border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-4">每小时活动</h3>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={stats.hourlyActivity} barCategoryGap="15%">
            <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
            <XAxis dataKey="hour" tickFormatter={(h: number) => `${h}:00`} tick={{ fontSize: 11 }} interval={2} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip
              labelFormatter={(h) => `${h}:00 - ${Number(h)}:59`}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="messagesReceived" name="收到消息" fill="#3b82f6" radius={[2, 2, 0, 0]} />
            <Bar dataKey="messagesSent" name="发送消息" fill="#10b981" radius={[2, 2, 0, 0]} />
            <Bar dataKey="llmCalls" name="LLM 调用" fill="#8b5cf6" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-white dark:bg-zinc-800 rounded-xl p-4 border border-zinc-200 dark:border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-4">Provider 调用分布</h3>
        {stats.providerStats.length > 0 ? (
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie
                data={stats.providerStats}
                dataKey="callCount"
                nameKey="provider"
                cx="50%"
                cy="50%"
                outerRadius={90}
                label={(props) => {
                  const p = props as unknown as { provider: string; callCount: number };
                  return `${p.provider} (${p.callCount})`;
                }}
                labelLine={{ strokeWidth: 1 }}
              >
                {stats.providerStats.map((ps) => (
                  <Cell
                    key={ps.provider}
                    fill={DAILY_STATS_PIE_COLORS[stats.providerStats.indexOf(ps) % DAILY_STATS_PIE_COLORS.length]}
                  />
                ))}
              </Pie>
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-[260px] text-zinc-400 text-sm">暂无 LLM 调用数据</div>
        )}
      </div>
    </div>
  );
}
