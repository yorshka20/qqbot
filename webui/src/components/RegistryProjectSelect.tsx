import * as Select from '@radix-ui/react-select';
import { AlertTriangle, Check, ChevronDown } from 'lucide-react';
import type { ProjectRegistryEntry } from '../types';

const UNKNOWN_SENTINEL = '__project_unknown__';

/**
 * Single-select for a ProjectRegistry alias. Values always come from the
 * registry snapshot (`GET /api/cluster/projects`). If the caller passes
 * a `value` not in the snapshot (e.g. pasted from a ticket header on a
 * machine with a different registry), the value is preserved and
 * rendered as a "⚠ unknown" warning row. Save gating is enforced upstream
 * (callers check `projects.some(p => p.alias === value)` before allowing
 * submit).
 *
 * Radix Select is used for styling parity with TemplateSelect /
 * StatusSelect.
 */
export function RegistryProjectSelect({
  value,
  onChange,
  projects,
  disabled,
}: {
  value: string;
  onChange: (alias: string) => void;
  projects: ProjectRegistryEntry[];
  disabled?: boolean;
  /** Unused — kept for backwards-compat with existing callers that pass `id`. */
  id?: string;
}) {
  const loading = projects.length === 0;
  const listed = projects.some((p) => p.alias === value);
  const isUnknown = !loading && value !== '' && !listed;

  if (loading) {
    return (
      <div className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-400 text-sm">
        Loading projects…
      </div>
    );
  }

  const triggerBorder = isUnknown
    ? 'border-amber-400 dark:border-amber-500 text-amber-700 dark:text-amber-400'
    : 'border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100';

  return (
    <Select.Root
      value={value || UNKNOWN_SENTINEL}
      onValueChange={(v) => onChange(v === UNKNOWN_SENTINEL ? value : v)}
      disabled={disabled}
    >
      <Select.Trigger
        className={`w-full px-3 py-2 rounded-lg border bg-white dark:bg-zinc-900 text-sm flex items-center justify-between gap-2 disabled:opacity-50 ${triggerBorder}`}
        aria-label="project"
      >
        <Select.Value>
          <TriggerLabel value={value} isUnknown={isUnknown} projects={projects} />
        </Select.Value>
        <Select.Icon>
          <ChevronDown className="w-4 h-4 text-zinc-500" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-[60] min-w-[var(--radix-select-trigger-width)] max-h-[320px] overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-lg"
        >
          <Select.Viewport className="p-1">
            {projects.map((p) => (
              <Select.Item
                key={p.alias}
                value={p.alias}
                className="relative flex items-center gap-2 pl-8 pr-3 py-1.5 text-sm rounded cursor-pointer data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-700 outline-none"
              >
                <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                  <Check className="w-3.5 h-3.5" />
                </Select.ItemIndicator>
                <Select.ItemText>
                  <span className="font-medium">{p.alias}</span>
                </Select.ItemText>
                {p.isDefault && <span className="ml-auto text-[11px] text-zinc-500">default</span>}
              </Select.Item>
            ))}
            {isUnknown && (
              <Select.Item
                value={UNKNOWN_SENTINEL}
                disabled
                className="relative flex items-center gap-2 pl-8 pr-3 py-1.5 text-sm text-amber-700 dark:text-amber-400 outline-none opacity-90"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                <Select.ItemText>
                  <span className="truncate">{value}</span>
                </Select.ItemText>
                <span className="ml-auto text-[11px]">not in registry</span>
              </Select.Item>
            )}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function TriggerLabel({
  value,
  isUnknown,
  projects,
}: {
  value: string;
  isUnknown: boolean;
  projects: ProjectRegistryEntry[];
}) {
  if (isUnknown) {
    return (
      <span className="flex items-center gap-1.5 truncate">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{value}</span>
        <span className="text-[10px] uppercase tracking-wide">unknown</span>
      </span>
    );
  }
  const entry = projects.find((p) => p.alias === value);
  if (!entry) return <span className="text-zinc-400">Select project…</span>;
  return (
    <span className="flex items-center gap-2 truncate">
      <span className="truncate font-medium">{entry.alias}</span>
      {entry.isDefault && <span className="text-[11px] text-zinc-500 shrink-0">default</span>}
    </span>
  );
}
