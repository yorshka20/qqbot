/**
 * Daily Stats Page - Log-based daily statistics dashboard.
 * Shows message counts, LLM usage, error summary, hourly activity, and group activity.
 */

import {
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Cpu,
  FileText,
  MessageSquare,
  Send,
  Users,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
} from "recharts";

import { getDailyStats, getStatsDates } from "../api";
import type { DailyStats } from "../types";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const PIE_COLORS = [
  "#3b82f6",
  "#8b5cf6",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#ec4899",
  "#06b6d4",
  "#84cc16",
];

// ────────────────────────────────────────────────────────────────────────────
// Summary Card
// ────────────────────────────────────────────────────────────────────────────

function StatCard({
  icon,
  label,
  value,
  subValue,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  subValue?: string;
  color: string;
}) {
  return (
    <div className="bg-white dark:bg-zinc-800 rounded-xl p-4 border border-zinc-200 dark:border-zinc-700">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg ${color}`}>{icon}</div>
        <div className="min-w-0">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{label}</p>
          <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            {value}
          </p>
          {subValue && (
            <p className="text-xs text-zinc-400 dark:text-zinc-500 truncate">
              {subValue}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main Page
// ────────────────────────────────────────────────────────────────────────────

export function DailyStatsPage() {
  const [date, setDate] = useState(todayString);
  const [dates, setDates] = useState<string[]>([]);
  const [stats, setStats] = useState<DailyStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load available dates
  useEffect(() => {
    getStatsDates()
      .then((r) => setDates(r.dates))
      .catch(() => {});
  }, []);

  // Load stats for selected date
  const loadStats = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await getDailyStats(d);
      setStats(res.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stats");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats(date);
  }, [date, loadStats]);

  // Navigate between dates by ±1 day
  const shiftDate = useCallback(
    (delta: number) => {
      const d = new Date(`${date}T00:00:00`);
      d.setDate(d.getDate() + delta);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      setDate(`${y}-${m}-${day}`);
    },
    [date],
  );

  const goToPrevDay = useCallback(() => shiftDate(-1), [shiftDate]);
  const goToNextDay = useCallback(() => shiftDate(1), [shiftDate]);

  const canGoPrev = dates.length > 0 ? date > dates[dates.length - 1] : true;
  const canGoNext = date < todayString();

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      {/* Date Selector */}
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <BarChart3 className="w-5 h-5" />
          每日统计
        </h1>
        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            onClick={goToPrevDay}
            disabled={!canGoPrev}
            className="p-1.5 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-30 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <input
            type="date"
            value={date}
            max={todayString()}
            min={dates.length > 0 ? dates[dates.length - 1] : undefined}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100"
          />
          <button
            type="button"
            onClick={goToNextDay}
            disabled={!canGoNext}
            className="p-1.5 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-30 transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {loading && (
        <div className="text-center py-12 text-zinc-400">加载中...</div>
      )}

      {error && <div className="text-center py-12 text-red-500">{error}</div>}

      {stats && !loading && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              icon={<MessageSquare className="w-5 h-5 text-blue-600" />}
              label="收到消息"
              value={formatNumber(stats.summary.totalMessagesReceived)}
              color="bg-blue-50 dark:bg-blue-900/30"
            />
            <StatCard
              icon={<Send className="w-5 h-5 text-green-600" />}
              label="发送消息"
              value={formatNumber(stats.summary.totalMessagesSent)}
              color="bg-green-50 dark:bg-green-900/30"
            />
            <StatCard
              icon={<Cpu className="w-5 h-5 text-purple-600" />}
              label="LLM 调用"
              value={formatNumber(stats.summary.totalLLMCalls)}
              subValue={`${stats.providerStats.length} 个 provider`}
              color="bg-purple-50 dark:bg-purple-900/30"
            />
            <StatCard
              icon={<Zap className="w-5 h-5 text-amber-600" />}
              label="Token 消耗"
              value={formatNumber(stats.summary.totalTokensUsed)}
              subValue={`prompt: ${formatNumber(stats.summary.totalPromptChars)} chars`}
              color="bg-amber-50 dark:bg-amber-900/30"
            />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              icon={<AlertTriangle className="w-5 h-5 text-red-600" />}
              label="错误"
              value={stats.summary.totalErrors}
              color="bg-red-50 dark:bg-red-900/30"
            />
            <StatCard
              icon={<AlertTriangle className="w-5 h-5 text-yellow-600" />}
              label="警告"
              value={stats.summary.totalWarnings}
              color="bg-yellow-50 dark:bg-yellow-900/30"
            />
            <StatCard
              icon={<FileText className="w-5 h-5 text-zinc-600" />}
              label="日志文件"
              value={stats.logFileCount}
              subValue="次重启"
              color="bg-zinc-100 dark:bg-zinc-700/50"
            />
            <StatCard
              icon={<Users className="w-5 h-5 text-cyan-600" />}
              label="活跃群组"
              value={stats.topGroups.length}
              color="bg-cyan-50 dark:bg-cyan-900/30"
            />
          </div>

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Hourly Activity Chart */}
            <div className="bg-white dark:bg-zinc-800 rounded-xl p-4 border border-zinc-200 dark:border-zinc-700">
              <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-4">
                每小时活动
              </h3>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={stats.hourlyActivity} barCategoryGap="15%">
                  <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
                  <XAxis
                    dataKey="hour"
                    tickFormatter={(h: number) => `${h}:00`}
                    tick={{ fontSize: 11 }}
                    interval={2}
                  />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip
                    labelFormatter={(h) => `${h}:00 - ${Number(h)}:59`}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar
                    dataKey="messagesReceived"
                    name="收到消息"
                    fill="#3b82f6"
                    radius={[2, 2, 0, 0]}
                  />
                  <Bar
                    dataKey="messagesSent"
                    name="发送消息"
                    fill="#10b981"
                    radius={[2, 2, 0, 0]}
                  />
                  <Bar
                    dataKey="llmCalls"
                    name="LLM 调用"
                    fill="#8b5cf6"
                    radius={[2, 2, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Provider Distribution Pie */}
            <div className="bg-white dark:bg-zinc-800 rounded-xl p-4 border border-zinc-200 dark:border-zinc-700">
              <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-4">
                Provider 调用分布
              </h3>
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
                        const p = props as unknown as {
                          provider: string;
                          callCount: number;
                        };
                        return `${p.provider} (${p.callCount})`;
                      }}
                      labelLine={{ strokeWidth: 1 }}
                    >
                      {stats.providerStats.map((ps) => (
                        <Cell
                          key={ps.provider}
                          fill={
                            PIE_COLORS[
                              stats.providerStats.indexOf(ps) %
                                PIE_COLORS.length
                            ]
                          }
                        />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-[260px] text-zinc-400 text-sm">
                  暂无 LLM 调用数据
                </div>
              )}
            </div>
          </div>

          {/* Provider Details Table */}
          {stats.providerStats.length > 0 && (
            <div className="bg-white dark:bg-zinc-800 rounded-xl p-4 border border-zinc-200 dark:border-zinc-700">
              <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3">
                Provider 详细统计
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-700">
                      <th className="pb-2 pr-4">Provider</th>
                      <th className="pb-2 pr-4 text-right">调用次数</th>
                      <th className="pb-2 pr-4 text-right">Prompt Tokens</th>
                      <th className="pb-2 pr-4 text-right">
                        Completion Tokens
                      </th>
                      <th className="pb-2 pr-4 text-right">总 Tokens</th>
                      <th className="pb-2 pr-4 text-right">Prompt 字符</th>
                      <th className="pb-2 text-right">回复字符</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.providerStats.map((ps) => (
                      <tr
                        key={ps.provider}
                        className="border-b border-zinc-100 dark:border-zinc-700/50"
                      >
                        <td className="py-2 pr-4 font-medium text-zinc-800 dark:text-zinc-200">
                          {ps.provider}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {ps.callCount}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {formatNumber(ps.promptTokens)}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {formatNumber(ps.completionTokens)}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {formatNumber(ps.totalTokens)}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {formatNumber(ps.promptChars)}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {formatNumber(ps.responseChars)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Bottom Row: Groups + Errors */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Top Groups */}
            <div className="bg-white dark:bg-zinc-800 rounded-xl p-4 border border-zinc-200 dark:border-zinc-700">
              <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3">
                活跃群组 Top 10
              </h3>
              {stats.topGroups.length > 0 ? (
                <div className="space-y-2">
                  {stats.topGroups.slice(0, 10).map((g, i) => {
                    const maxCount = stats.topGroups[0].messageCount;
                    const pct =
                      maxCount > 0 ? (g.messageCount / maxCount) * 100 : 0;
                    return (
                      <div key={g.groupId} className="flex items-center gap-3">
                        <span className="w-5 text-right text-xs text-zinc-400 shrink-0">
                          {i + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                            <span className="text-sm truncate text-zinc-700 dark:text-zinc-300">
                              {g.groupName}
                            </span>
                            <span className="text-xs text-zinc-500 shrink-0 ml-2">
                              {g.messageCount} 条
                            </span>
                          </div>
                          <div className="h-1.5 bg-zinc-100 dark:bg-zinc-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-500 rounded-full transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-zinc-400 text-sm py-4 text-center">
                  暂无群组数据
                </div>
              )}
            </div>

            {/* Recent Errors */}
            <div className="bg-white dark:bg-zinc-800 rounded-xl p-4 border border-zinc-200 dark:border-zinc-700">
              <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3">
                错误日志
                {stats.recentErrors.length > 0 && (
                  <span className="ml-2 text-xs font-normal text-red-500">
                    ({stats.recentErrors.length})
                  </span>
                )}
              </h3>
              {stats.recentErrors.length > 0 ? (
                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                  {stats.recentErrors.map((err) => (
                    <div
                      key={err.timestamp}
                      className="text-xs p-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-red-600 dark:text-red-400 font-medium">
                          [{err.component}]
                        </span>
                        <span className="text-zinc-400">
                          {err.timestamp.split(" ")[1]}
                        </span>
                      </div>
                      <p className="text-zinc-600 dark:text-zinc-400 break-all">
                        {err.message}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-green-600 dark:text-green-400 text-sm py-4 text-center">
                  今日无错误
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
