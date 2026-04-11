import { BarChart3, ChevronLeft, ChevronRight } from 'lucide-react';

import { todayString } from '../utils';

export function DailyStatsDateBar({
  date,
  dates,
  onDateChange,
  onPrevDay,
  onNextDay,
}: {
  date: string;
  dates: string[];
  onDateChange: (d: string) => void;
  onPrevDay: () => void;
  onNextDay: () => void;
}) {
  const canGoPrev = dates.length > 0 ? date > dates[dates.length - 1] : true;
  const canGoNext = date < todayString();

  return (
    <div className="flex items-center gap-4">
      <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
        <BarChart3 className="w-5 h-5" />
        每日统计
      </h1>
      <div className="flex items-center gap-2 ml-auto">
        <button
          type="button"
          onClick={onPrevDay}
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
          onChange={(e) => e.target.value && onDateChange(e.target.value)}
          className="px-3 py-1.5 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100"
        />
        <button
          type="button"
          onClick={onNextDay}
          disabled={!canGoNext}
          className="p-1.5 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-30 transition-colors"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
