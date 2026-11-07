/**
 * Daily Stats page (route entry) — log-based daily statistics dashboard.
 */

import type { DailyStats, UsageDailyReport } from '@qqbot/api-types';
import { useCallback, useEffect, useState } from 'react';
import { getDailyStats, getStatsDates, getUsageReport } from '../../api';
import { DailyStatsCharts } from './components/DailyStatsCharts';
import { DailyStatsDateBar } from './components/DailyStatsDateBar';
import { DailyStatsGroupsAndErrors } from './components/DailyStatsGroupsAndErrors';
import { DailyStatsProviderTable } from './components/DailyStatsProviderTable';
import { DailyStatsSummaryCards } from './components/DailyStatsSummaryCards';
import { DailyStatsUsageCost } from './components/DailyStatsUsageCost';
import { todayString } from './utils';

export function DailyStatsPage() {
  const [date, setDate] = useState(todayString);
  const [dates, setDates] = useState<string[]>([]);
  const [stats, setStats] = useState<DailyStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageDailyReport | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  useEffect(() => {
    getStatsDates()
      .then((r) => setDates(r.dates))
      .catch(() => {});
  }, []);

  const loadStats = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await getDailyStats(d);
      setStats(res.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadUsage = useCallback(async (d: string) => {
    setUsage(null);
    setUsageError(null);
    try {
      const res = await getUsageReport(d);
      setUsage(res.report);
    } catch (err) {
      setUsageError(err instanceof Error ? err.message : 'Failed to load usage');
    }
  }, []);

  useEffect(() => {
    loadStats(date);
    loadUsage(date);
  }, [date, loadStats, loadUsage]);

  const shiftDate = useCallback(
    (delta: number) => {
      const d = new Date(`${date}T00:00:00`);
      d.setDate(d.getDate() + delta);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      setDate(`${y}-${m}-${day}`);
    },
    [date],
  );

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <DailyStatsDateBar
        date={date}
        dates={dates}
        onDateChange={setDate}
        onPrevDay={() => shiftDate(-1)}
        onNextDay={() => shiftDate(1)}
      />

      {loading && <div className="text-center py-12 text-zinc-400">加载中...</div>}

      {error && <div className="text-center py-12 text-red-500">{error}</div>}

      {stats && !loading && (
        <>
          <DailyStatsSummaryCards stats={stats} />
          <DailyStatsUsageCost report={usage} error={usageError} />
          <DailyStatsCharts stats={stats} />
          <DailyStatsProviderTable stats={stats} />
          <DailyStatsGroupsAndErrors stats={stats} />
        </>
      )}
    </div>
  );
}
