import type { DailyStats } from '../../../types';
import { formatNumber } from '../utils';

export function DailyStatsProviderTable({ stats }: { stats: DailyStats }) {
  if (stats.providerStats.length === 0) return null;

  return (
    <div className="bg-white dark:bg-zinc-800 rounded-xl p-4 border border-zinc-200 dark:border-zinc-700">
      <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3">Provider 详细统计</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-700">
              <th className="pb-2 pr-4">Provider</th>
              <th className="pb-2 pr-4 text-right">调用次数</th>
              <th className="pb-2 pr-4 text-right">Prompt Tokens</th>
              <th className="pb-2 pr-4 text-right">Completion Tokens</th>
              <th className="pb-2 pr-4 text-right">总 Tokens</th>
              <th className="pb-2 pr-4 text-right">Prompt 字符</th>
              <th className="pb-2 text-right">回复字符</th>
            </tr>
          </thead>
          <tbody>
            {stats.providerStats.map((ps) => (
              <tr key={ps.provider} className="border-b border-zinc-100 dark:border-zinc-700/50">
                <td className="py-2 pr-4 font-medium text-zinc-800 dark:text-zinc-200">{ps.provider}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{ps.callCount}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{formatNumber(ps.promptTokens)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{formatNumber(ps.completionTokens)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{formatNumber(ps.totalTokens)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{formatNumber(ps.promptChars)}</td>
                <td className="py-2 text-right tabular-nums">{formatNumber(ps.responseChars)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
