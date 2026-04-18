/**
 * Date filter for Moments page — supports day, month, and year selection modes.
 * Uses react-day-picker v9 for the calendar UI.
 */

import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Calendar, ChevronDown, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/style.css';

export type DateFilterMode = 'day' | 'month' | 'year';

export interface DateFilterValue {
  mode: DateFilterMode;
  /** "YYYY-MM-DD" | "YYYY-MM" | "YYYY" | "" */
  value: string;
}

interface Props {
  value: DateFilterValue;
  onChange: (v: DateFilterValue) => void;
}

const MODE_LABELS: Record<DateFilterMode, string> = {
  day: '按日',
  month: '按月',
  year: '按年',
};

export function MomentsDateFilter({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open && !modeMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setModeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, modeMenuOpen]);

  const handleDaySelect = useCallback(
    (day: Date | undefined) => {
      if (!day) return;
      onChange({ mode: 'day', value: format(day, 'yyyy-MM-dd') });
      setOpen(false);
    },
    [onChange],
  );

  const handleMonthSelect = useCallback(
    (month: Date) => {
      onChange({ mode: 'month', value: format(month, 'yyyy-MM') });
      setOpen(false);
    },
    [onChange],
  );

  const handleYearClick = useCallback(
    (year: number) => {
      onChange({ mode: 'year', value: String(year) });
      setOpen(false);
    },
    [onChange],
  );

  const clear = useCallback(() => {
    onChange({ mode: value.mode, value: '' });
  }, [onChange, value.mode]);

  const selectMode = useCallback(
    (mode: DateFilterMode) => {
      onChange({ mode, value: '' });
      setModeMenuOpen(false);
    },
    [onChange],
  );

  const displayLabel = value.value || '选择日期';

  return (
    <div ref={ref} className="relative inline-flex items-center gap-1">
      {/* Mode dropdown */}
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setModeMenuOpen(!modeMenuOpen);
            setOpen(false);
          }}
          className="px-2 py-1.5 text-xs rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors flex items-center gap-1"
        >
          {MODE_LABELS[value.mode]}
          <ChevronDown className="w-3 h-3" />
        </button>
        {modeMenuOpen && (
          <div className="absolute top-full left-0 mt-1 z-50 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 min-w-[72px]">
            {(Object.entries(MODE_LABELS) as [DateFilterMode, string][]).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => selectMode(mode)}
                className={`w-full px-3 py-1.5 text-xs text-left transition-colors ${
                  value.mode === mode
                    ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                    : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Trigger */}
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setModeMenuOpen(false);
        }}
        className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors flex items-center gap-1.5 ${
          value.value
            ? 'border-blue-400 dark:border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
            : 'border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-700'
        }`}
      >
        <Calendar className="w-3.5 h-3.5" />
        {displayLabel}
      </button>

      {/* Clear */}
      {value.value && (
        <button
          type="button"
          onClick={clear}
          className="p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-lg p-2">
          {value.mode === 'day' && (
            <DayPicker
              mode="single"
              locale={zhCN}
              selected={value.value ? new Date(value.value) : undefined}
              onSelect={handleDaySelect}
              className="!font-sans text-sm"
            />
          )}
          {value.mode === 'month' && <MonthGrid onSelect={handleMonthSelect} selected={value.value} />}
          {value.mode === 'year' && <YearGrid onSelect={handleYearClick} selected={value.value} />}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Month picker grid
// ────────────────────────────────────────────────────────────────────────────

function MonthGrid({ onSelect, selected }: { onSelect: (d: Date) => void; selected: string }) {
  const [year, setYear] = useState(() => {
    if (selected) return Number(selected.slice(0, 4));
    return new Date().getFullYear();
  });
  const months = Array.from({ length: 12 }, (_, i) => i);

  return (
    <div className="w-64 p-2">
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={() => setYear((y) => y - 1)}
          className="px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-700 rounded"
        >
          ←
        </button>
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{year}</span>
        <button
          type="button"
          onClick={() => setYear((y) => y + 1)}
          className="px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-700 rounded"
        >
          →
        </button>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {months.map((m) => {
          const val = `${year}-${String(m + 1).padStart(2, '0')}`;
          const isSelected = selected === val;
          return (
            <button
              key={m}
              type="button"
              onClick={() => onSelect(new Date(year, m, 1))}
              className={`px-2 py-1.5 text-xs rounded transition-colors ${
                isSelected
                  ? 'bg-blue-500 text-white'
                  : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700'
              }`}
            >
              {m + 1}月
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Year picker grid
// ────────────────────────────────────────────────────────────────────────────

function YearGrid({ onSelect, selected }: { onSelect: (y: number) => void; selected: string }) {
  const currentYear = new Date().getFullYear();
  const [startYear, setStartYear] = useState(() => {
    if (selected) return Math.floor(Number(selected) / 10) * 10;
    return Math.floor(currentYear / 10) * 10;
  });
  const years = Array.from({ length: 12 }, (_, i) => startYear - 1 + i);

  return (
    <div className="w-64 p-2">
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={() => setStartYear((y) => y - 10)}
          className="px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-700 rounded"
        >
          ←
        </button>
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          {startYear} - {startYear + 9}
        </span>
        <button
          type="button"
          onClick={() => setStartYear((y) => y + 10)}
          className="px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-700 rounded"
        >
          →
        </button>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {years.map((y) => {
          const isSelected = selected === String(y);
          return (
            <button
              key={y}
              type="button"
              onClick={() => onSelect(y)}
              className={`px-2 py-1.5 text-xs rounded transition-colors ${
                isSelected
                  ? 'bg-blue-500 text-white'
                  : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700'
              }`}
            >
              {y}
            </button>
          );
        })}
      </div>
    </div>
  );
}
