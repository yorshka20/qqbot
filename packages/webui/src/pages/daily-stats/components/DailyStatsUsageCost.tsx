import type { UsageDailyReport, UsageUserAgg } from '@qqbot/api-types';
import { DollarSign, Image, Users, Zap } from 'lucide-react';
import { StatCard } from '../../../components/StatCard';
import { formatNumber } from '../utils';

const PANEL = 'bg-white dark:bg-zinc-800 rounded-xl p-4 border border-zinc-200 dark:border-zinc-700';

function formatCost(cost: number): string {
  return `$${cost.toFixed(cost > 0 && cost < 0.01 ? 4 : 2)}`;
}

export function DailyStatsUsageCost({ report, error }: { report: UsageDailyReport | null; error: string | null }) {
  if (error || !report) {
    return (
      <div className={PANEL}>
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3">费用</h3>
        {error ? (
          <p className="text-sm text-red-500">费用加载失败：{error}</p>
        ) : (
          <p className="text-sm text-zinc-400">费用加载中...</p>
        )}
      </div>
    );
  }

  const users = [...report.topUsers].sort((a, b) => b.cost - a.cost);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={<DollarSign className="w-5 h-5 text-emerald-600" />}
          label="总费用"
          value={formatCost(report.cost)}
          color="bg-emerald-50 dark:bg-emerald-900/30"
        />
        <StatCard
          icon={<Zap className="w-5 h-5 text-amber-600" />}
          label="总 Tokens"
          value={formatNumber(report.totalTokens)}
          subValue={`prompt ${formatNumber(report.promptTokens)} / completion ${formatNumber(report.completionTokens)}`}
          color="bg-amber-50 dark:bg-amber-900/30"
        />
        <StatCard
          icon={<Image className="w-5 h-5 text-pink-600" />}
          label="图片"
          value={formatNumber(report.totalImages)}
          color="bg-pink-50 dark:bg-pink-900/30"
        />
        <StatCard
          icon={<Users className="w-5 h-5 text-cyan-600" />}
          label="用户"
          value={report.userCount}
          color="bg-cyan-50 dark:bg-cyan-900/30"
        />
      </div>

      {report.unpricedModels.length > 0 && (
        <div className="rounded-xl border border-yellow-300 bg-yellow-50 dark:bg-yellow-900/30 dark:border-yellow-700 px-4 py-3 text-sm text-yellow-800 dark:text-yellow-200">
          未定价模型（费用按 $0 计，实际开销被低估）：{report.unpricedModels.join(', ')}
        </div>
      )}

      <div className={PANEL}>
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3">用户费用</h3>
        {users.length === 0 ? (
          <p className="text-sm text-zinc-400 py-4 text-center">当天没有用量记录</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-700">
                  <th className="pb-2 pr-4">用户</th>
                  <th className="pb-2 pr-4 text-right">Prompt Tokens</th>
                  <th className="pb-2 pr-4 text-right">Completion Tokens</th>
                  <th className="pb-2 pr-4 text-right">图片</th>
                  <th className="pb-2 text-right">费用</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <UserRows key={user.userId} user={user} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-3">按官方价计算，与 /usage 一致</p>
      </div>
    </div>
  );
}

function UserRows({ user }: { user: UsageUserAgg }) {
  const providers = [...user.byProvider].sort((a, b) => b.cost - a.cost);
  return (
    <>
      <tr className="border-b border-zinc-100 dark:border-zinc-700/50">
        <td className="py-2 pr-4 font-medium text-zinc-800 dark:text-zinc-200">{user.nickname ?? user.userId}</td>
        <td className="py-2 pr-4 text-right tabular-nums">{formatNumber(user.promptTokens)}</td>
        <td className="py-2 pr-4 text-right tabular-nums">{formatNumber(user.completionTokens)}</td>
        <td className="py-2 pr-4 text-right tabular-nums">{formatNumber(user.totalImages)}</td>
        <td className="py-2 text-right tabular-nums">{formatCost(user.cost)}</td>
      </tr>
      {providers.map((p) => (
        <tr key={`${user.userId}:${p.provider}:${p.type}`} className="text-xs text-zinc-500 dark:text-zinc-400">
          <td className="py-1 pr-4 pl-4">
            {p.provider}
            {p.type === 'image' ? '（图片）' : ''}
          </td>
          <td className="py-1 pr-4 text-right tabular-nums">{formatNumber(p.promptTokens)}</td>
          <td className="py-1 pr-4 text-right tabular-nums">{formatNumber(p.completionTokens)}</td>
          <td className="py-1 pr-4 text-right tabular-nums">{formatNumber(p.imageCount)}</td>
          <td className="py-1 text-right tabular-nums">{formatCost(p.cost)}</td>
        </tr>
      ))}
    </>
  );
}
