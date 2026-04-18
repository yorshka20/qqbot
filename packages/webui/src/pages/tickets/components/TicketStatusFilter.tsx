import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown, Filter, X } from 'lucide-react';
import type { TicketStatus } from '../../../types';
import { ticketStatusBadgeClass } from '../utils';

const ALL_SENTINEL = '__all__';

/** Workflow order for the dropdown (same as typical ticket lifecycle). */
const STATUS_OPTIONS: TicketStatus[] = ['draft', 'ready', 'dispatched', 'done', 'abandoned'];

/**
 * Status filter dropdown for the tickets page — same Radix Select shell as
 * `TicketProjectFilter` so the header stays visually consistent.
 */
export function TicketStatusFilter({
  value,
  onChange,
}: {
  /** null = all statuses */
  value: TicketStatus | null;
  onChange: (value: TicketStatus | null) => void;
}) {
  const radixValue = value === null ? ALL_SENTINEL : value;
  const handleChange = (v: string) => {
    onChange(v === ALL_SENTINEL ? null : (v as TicketStatus));
  };

  return (
    <div className="flex items-center gap-1">
      <Select.Root value={radixValue} onValueChange={handleChange}>
        <Select.Trigger
          className="px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs flex items-center gap-2 text-zinc-700 dark:text-zinc-300 min-w-[140px]"
          aria-label="Filter by status"
        >
          <Filter className="w-3 h-3 shrink-0 text-zinc-500" />
          <Select.Value>
            <TriggerLabel value={value} />
          </Select.Value>
          <Select.Icon className="ml-auto">
            <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            position="popper"
            sideOffset={4}
            className="z-[60] min-w-[var(--radix-select-trigger-width)] max-h-[320px] overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-lg"
          >
            <Select.Viewport className="p-1">
              <Select.Item
                value={ALL_SENTINEL}
                className="relative flex items-center gap-2 pl-8 pr-3 py-1.5 text-sm rounded cursor-pointer data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-700 outline-none"
              >
                <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                  <Check className="w-3.5 h-3.5" />
                </Select.ItemIndicator>
                <Select.ItemText>all statuses</Select.ItemText>
              </Select.Item>
              {STATUS_OPTIONS.map((s) => (
                <Select.Item
                  key={s}
                  value={s}
                  className="relative flex items-center gap-2 pl-8 pr-3 py-1.5 text-sm rounded cursor-pointer data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-700 outline-none"
                >
                  <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                    <Check className="w-3.5 h-3.5" />
                  </Select.ItemIndicator>
                  <Select.ItemText>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-medium ${ticketStatusBadgeClass(s)}`}
                    >
                      {s}
                    </span>
                  </Select.ItemText>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
      {value !== null && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="p-1 rounded text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700"
          title="Clear filter"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

function TriggerLabel({ value }: { value: TicketStatus | null }) {
  if (value === null) {
    return <span className="text-zinc-500 dark:text-zinc-400">all statuses</span>;
  }
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-medium ${ticketStatusBadgeClass(value)}`}>
      {value}
    </span>
  );
}
