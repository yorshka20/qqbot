import { AlertTriangle, Cpu, FileText, MessageSquare, Send, Users, Zap } from 'lucide-react';

import { StatCard } from '../../../components/StatCard';
import type { DailyStats } from '../../../types';
import { formatNumber } from '../utils';

export function DailyStatsSummaryCards({ stats }: { stats: DailyStats }) {
  return (
    <>
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
    </>
  );
}
