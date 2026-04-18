import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { FileText, Loader2, MessageSquare, Newspaper, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { listReports } from '../api';
import type { ReportListItem } from '../types';

interface ReportListProps {
  onSelectReport: (id: string) => void;
}

const TYPE_LABELS: Record<string, string> = {
  daily: '日报',
  weekly: '周报',
  monthly: '月报',
  custom: '报告',
};

const TYPE_COLORS: Record<string, string> = {
  daily: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300',
  weekly: 'bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300',
  monthly: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
  custom: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300',
};

export function ReportList({ onSelectReport }: ReportListProps) {
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listReports();
      setReports(data.reports);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load reports');
      setReports([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="flex flex-col items-center gap-3 text-zinc-500 dark:text-zinc-400">
          <Loader2 className="w-10 h-10 animate-spin text-zinc-400 dark:text-zinc-500" />
          <span className="text-sm font-medium">加载报告列表...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-950/40 dark:border-red-900 p-6 text-red-800 dark:text-red-300 text-sm">
        {error}
      </div>
    );
  }

  if (reports.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-zinc-500 dark:text-zinc-400">
        <FileText className="w-16 h-16 mb-4 text-zinc-300 dark:text-zinc-600" />
        <p className="text-lg font-medium">暂无报告</p>
        <p className="text-sm mt-1">当生成微信日报后，报告将显示在这里</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {reports.map((report) => (
        <button
          type="button"
          key={report.id}
          onClick={() => onSelectReport(report.id)}
          className="group text-left p-5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-md transition-all"
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-2 mb-3">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${TYPE_COLORS[report.type] ?? TYPE_COLORS.custom}`}
            >
              {TYPE_LABELS[report.type] ?? report.type}
            </span>
            <span className="text-xs text-zinc-400 dark:text-zinc-500">
              {format(new Date(report.generatedAt), 'MM/dd HH:mm', { locale: zhCN })}
            </span>
          </div>

          {/* Title */}
          <h3 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors line-clamp-2">
            {report.title}
          </h3>

          {/* Period */}
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">{report.period}</p>

          {/* Stats */}
          <div className="flex items-center gap-4 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="flex items-center gap-1">
              <MessageSquare className="w-3.5 h-3.5" />
              {report.stats.totalMessages}
            </span>
            <span className="flex items-center gap-1">
              <Newspaper className="w-3.5 h-3.5" />
              {report.stats.totalArticles}
            </span>
            <span className="flex items-center gap-1">
              <Users className="w-3.5 h-3.5" />
              {report.stats.groupCount}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
