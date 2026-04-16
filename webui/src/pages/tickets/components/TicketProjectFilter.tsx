import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown, Filter, X } from 'lucide-react';
import { projectBadgeClass } from '../utils';

const ALL_SENTINEL = '__all__';
const NONE_SENTINEL = '__none__';

/**
 * Project filter dropdown for the tickets page. Styling follows
 * `RegistryProjectSelect` / `TemplateSelect` (same Radix Select primitives,
 * same border / trigger classes) so the tickets header looks consistent
 * with the editor dialogs.
 *
 * Differs from RegistryProjectSelect in two ways:
 *   1. Source list is derived from the current tickets, NOT the registry
 *      snapshot — tickets can reference projects that have since been
 *      removed from the registry, and we still want to filter by them.
 *   2. Includes synthetic "all projects" and "(no project)" options, which
 *      RegistryProjectSelect intentionally doesn't expose (it's a picker,
 *      not a filter).
 *
 * Each option in the dropdown is rendered with the same stable-hash badge
 * color used in the ticket list cards so the filter visually echoes the
 * rows it will match.
 */
export function TicketProjectFilter({
  value,
  onChange,
  /** Unique project aliases present in the tickets list. Use `"__none__"` for the synthetic "no project" bucket. */
  options,
}: {
  /** null = "all projects" (no filter active). */
  value: string | null;
  onChange: (value: string | null) => void;
  options: string[];
}) {
  const radixValue = value === null ? ALL_SENTINEL : value;
  const handleChange = (v: string) => {
    onChange(v === ALL_SENTINEL ? null : v);
  };

  return (
    <div className="flex items-center gap-1">
      <Select.Root value={radixValue} onValueChange={handleChange}>
        <Select.Trigger
          className="px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs flex items-center gap-2 text-zinc-700 dark:text-zinc-300 min-w-[140px]"
          aria-label="Filter by project"
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
                <Select.ItemText>all projects</Select.ItemText>
              </Select.Item>
              {options.map((p) => (
                <Select.Item
                  key={p}
                  value={p}
                  className="relative flex items-center gap-2 pl-8 pr-3 py-1.5 text-sm rounded cursor-pointer data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-700 outline-none"
                >
                  <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                    <Check className="w-3.5 h-3.5" />
                  </Select.ItemIndicator>
                  {p === NONE_SENTINEL ? (
                    <Select.ItemText>
                      <span className="italic text-zinc-500 dark:text-zinc-400">(no project)</span>
                    </Select.ItemText>
                  ) : (
                    <Select.ItemText>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-medium ${projectBadgeClass(p)}`}>
                        {p}
                      </span>
                    </Select.ItemText>
                  )}
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

function TriggerLabel({ value }: { value: string | null }) {
  if (value === null) {
    return <span className="text-zinc-500 dark:text-zinc-400">all projects</span>;
  }
  if (value === NONE_SENTINEL) {
    return <span className="italic text-zinc-500 dark:text-zinc-400">(no project)</span>;
  }
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-medium ${projectBadgeClass(value)}`}>
      {value}
    </span>
  );
}
