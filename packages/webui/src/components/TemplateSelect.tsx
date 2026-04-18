import * as Select from '@radix-ui/react-select';
import { AlertTriangle, Check, ChevronDown, Cpu, Network } from 'lucide-react';
import { useMemo } from 'react';
import type { ClusterWorkerTemplate } from '../types';

const DEFAULT_SENTINEL = '__project_default__';

/**
 * Role-aware template picker. Groups templates into Planner / Executor
 * sections so the operator can't accidentally pick an executor when they
 * meant planner (or vice versa). Unknown values (e.g. templates pasted
 * from a ticket header on a machine with a different template config)
 * render as a warning item so the value is still preserved and visible.
 *
 * Radix Select is used instead of a native <select> — grouping with
 * visual role badges is clearer than `<optgroup>` alone, and styling
 * stays consistent with the existing Radix Dialog usage elsewhere.
 *
 * Empty string `""` means "use project default"; internally mapped to
 * a sentinel because Radix Select treats "" as "no selection".
 */
export function TemplateSelect({
  value,
  onChange,
  templates,
  disabled,
  defaultLabel = '(use project default)',
}: {
  value: string;
  onChange: (name: string) => void;
  templates: ClusterWorkerTemplate[];
  disabled?: boolean;
  /** Label for the "empty value" row — callers can inject project-specific hint like "(default: claude-sonnet)". */
  defaultLabel?: string;
}) {
  const { planners, executors, known } = useMemo(() => {
    const p: ClusterWorkerTemplate[] = [];
    const e: ClusterWorkerTemplate[] = [];
    const names = new Set<string>();
    for (const t of templates) {
      names.add(t.name);
      if (t.role === 'planner') p.push(t);
      else e.push(t);
    }
    return { planners: p, executors: e, known: names };
  }, [templates]);

  const isUnknown = value !== '' && !known.has(value);
  const radixValue = value === '' ? DEFAULT_SENTINEL : value;

  const handleChange = (v: string) => {
    onChange(v === DEFAULT_SENTINEL ? '' : v);
  };

  return (
    <Select.Root value={radixValue} onValueChange={handleChange} disabled={disabled}>
      <Select.Trigger
        className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 text-sm flex items-center justify-between gap-2 disabled:opacity-50 data-[placeholder]:text-zinc-400"
        aria-label="template"
      >
        <Select.Value>
          <TriggerLabel value={value} templates={templates} isUnknown={isUnknown} defaultLabel={defaultLabel} />
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
            <Item value={DEFAULT_SENTINEL} label={defaultLabel} muted />

            {planners.length > 0 && (
              <Select.Group>
                <GroupLabel icon={<Network className="w-3 h-3" />} text="Planner" tone="violet" />
                {planners.map((t) => (
                  <TemplateItem key={t.name} template={t} />
                ))}
              </Select.Group>
            )}

            {executors.length > 0 && (
              <Select.Group>
                <GroupLabel icon={<Cpu className="w-3 h-3" />} text="Executor" tone="sky" />
                {executors.map((t) => (
                  <TemplateItem key={t.name} template={t} />
                ))}
              </Select.Group>
            )}

            {isUnknown && (
              <Select.Group>
                <GroupLabel icon={<AlertTriangle className="w-3 h-3" />} text="Unknown (pasted)" tone="amber" />
                <Item value={value} label={value} warn />
              </Select.Group>
            )}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function TriggerLabel({
  value,
  templates,
  isUnknown,
  defaultLabel,
}: {
  value: string;
  templates: ClusterWorkerTemplate[];
  isUnknown: boolean;
  defaultLabel: string;
}) {
  if (value === '') return <span className="text-zinc-400">{defaultLabel}</span>;
  const t = templates.find((x) => x.name === value);
  if (!t) {
    return (
      <span className="flex items-center gap-1.5 truncate">
        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
        <span className="truncate">{value}</span>
        <span className="text-[10px] text-amber-600 dark:text-amber-400">unknown</span>
      </span>
    );
  }
  const roleTone =
    t.role === 'planner'
      ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
      : 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300';
  void isUnknown;
  return (
    <span className="flex items-center gap-2 truncate">
      <span className={`shrink-0 text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded ${roleTone}`}>
        {t.role ?? 'executor'}
      </span>
      <span className="truncate font-medium">{t.name}</span>
      <span className="text-[11px] text-zinc-500 shrink-0">
        {t.type} · {t.costTier}
      </span>
    </span>
  );
}

function GroupLabel({ icon, text, tone }: { icon: React.ReactNode; text: string; tone: 'violet' | 'sky' | 'amber' }) {
  const cls =
    tone === 'violet'
      ? 'text-violet-700 dark:text-violet-300'
      : tone === 'sky'
        ? 'text-sky-700 dark:text-sky-300'
        : 'text-amber-700 dark:text-amber-300';
  return (
    <Select.Label
      className={`flex items-center gap-1.5 px-2 py-1.5 text-[10px] uppercase tracking-wider font-semibold ${cls}`}
    >
      {icon}
      {text}
    </Select.Label>
  );
}

function TemplateItem({ template }: { template: ClusterWorkerTemplate }) {
  const roleTone =
    template.role === 'planner'
      ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
      : 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300';
  return (
    <Select.Item
      value={template.name}
      className="relative flex items-center gap-2 pl-8 pr-3 py-1.5 text-sm rounded cursor-pointer data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-700 outline-none"
    >
      <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
        <Check className="w-3.5 h-3.5" />
      </Select.ItemIndicator>
      <span className={`shrink-0 text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded ${roleTone}`}>
        {template.role ?? 'executor'}
      </span>
      <Select.ItemText>
        <span className="font-medium">{template.name}</span>
      </Select.ItemText>
      <span className="ml-auto text-[11px] text-zinc-500">
        {template.type} · {template.costTier}
      </span>
    </Select.Item>
  );
}

function Item({ value, label, muted, warn }: { value: string; label: string; muted?: boolean; warn?: boolean }) {
  return (
    <Select.Item
      value={value}
      className={`relative flex items-center gap-2 pl-8 pr-3 py-1.5 text-sm rounded cursor-pointer data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-700 outline-none ${
        muted ? 'text-zinc-500' : ''
      } ${warn ? 'text-amber-700 dark:text-amber-400' : ''}`}
    >
      <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
        <Check className="w-3.5 h-3.5" />
      </Select.ItemIndicator>
      {warn && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
      <Select.ItemText>{label}</Select.ItemText>
    </Select.Item>
  );
}
