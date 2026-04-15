import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { TicketStatus } from '../types';

const STATUS_OPTIONS: { value: TicketStatus; label: string; dot: string }[] = [
  { value: 'draft', label: 'draft', dot: 'bg-zinc-400' },
  { value: 'ready', label: 'ready', dot: 'bg-blue-500' },
  { value: 'dispatched', label: 'dispatched', dot: 'bg-amber-500' },
  { value: 'done', label: 'done', dot: 'bg-emerald-500' },
  { value: 'abandoned', label: 'abandoned', dot: 'bg-zinc-500' },
];

/**
 * Ticket lifecycle status picker. Colored dot per state helps the eye
 * catch the current value at a glance (especially in dense tables /
 * dashboards where multiple selects sit side by side).
 */
export function StatusSelect({
  value,
  onChange,
  disabled,
}: {
  value: TicketStatus;
  onChange: (v: TicketStatus) => void;
  disabled?: boolean;
}) {
  const current = STATUS_OPTIONS.find((o) => o.value === value) ?? STATUS_OPTIONS[0];

  return (
    <Select.Root value={value} onValueChange={(v) => onChange(v as TicketStatus)} disabled={disabled}>
      <Select.Trigger
        className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 text-sm flex items-center justify-between gap-2 disabled:opacity-50"
        aria-label="status"
      >
        <Select.Value>
          <span className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${current.dot}`} />
            {current.label}
          </span>
        </Select.Value>
        <Select.Icon>
          <ChevronDown className="w-4 h-4 text-zinc-500" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-[60] min-w-[var(--radix-select-trigger-width)] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-lg"
        >
          <Select.Viewport className="p-1">
            {STATUS_OPTIONS.map((o) => (
              <Select.Item
                key={o.value}
                value={o.value}
                className="relative flex items-center gap-2 pl-8 pr-3 py-1.5 text-sm rounded cursor-pointer data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-700 outline-none"
              >
                <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                  <Check className="w-3.5 h-3.5" />
                </Select.ItemIndicator>
                <span className={`w-2 h-2 rounded-full ${o.dot}`} />
                <Select.ItemText>{o.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
