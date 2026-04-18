import type { DailyStats } from '../../../types';

export function DailyStatsGroupsAndErrors({ stats }: { stats: DailyStats }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="bg-white dark:bg-zinc-800 rounded-xl p-4 border border-zinc-200 dark:border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3">活跃群组 Top 10</h3>
        {stats.topGroups.length > 0 ? (
          <div className="space-y-2">
            {stats.topGroups.slice(0, 10).map((g, i) => {
              const maxCount = stats.topGroups[0].messageCount;
              const pct = maxCount > 0 ? (g.messageCount / maxCount) * 100 : 0;
              return (
                <div key={g.groupId} className="flex items-center gap-3">
                  <span className="w-5 text-right text-xs text-zinc-400 shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-sm truncate text-zinc-700 dark:text-zinc-300">{g.groupName}</span>
                      <span className="text-xs text-zinc-500 shrink-0 ml-2">{g.messageCount} 条</span>
                    </div>
                    <div className="h-1.5 bg-zinc-100 dark:bg-zinc-700 rounded-full overflow-hidden">
                      <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-zinc-400 text-sm py-4 text-center">暂无群组数据</div>
        )}
      </div>

      <div className="bg-white dark:bg-zinc-800 rounded-xl p-4 border border-zinc-200 dark:border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3">
          错误日志
          {stats.recentErrors.length > 0 && (
            <span className="ml-2 text-xs font-normal text-red-500">({stats.recentErrors.length})</span>
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
                  <span className="text-red-600 dark:text-red-400 font-medium">[{err.component}]</span>
                  <span className="text-zinc-400">{err.timestamp.split(' ')[1]}</span>
                </div>
                <p className="text-zinc-600 dark:text-zinc-400 break-all">{err.message}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-green-600 dark:text-green-400 text-sm py-4 text-center">今日无错误</div>
        )}
      </div>
    </div>
  );
}
