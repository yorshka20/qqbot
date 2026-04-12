import type { ProjectRegistryEntry } from '../types';

/**
 * Single-select for a ProjectRegistry alias. Values always come from the
 * registry snapshot (`GET /api/cluster/projects`); there is no free-text
 * path — callers fetch `ProjectRegistryEntry[]` and pass it here.
 */
export function RegistryProjectSelect({
  value,
  onChange,
  projects,
  disabled,
  id,
}: {
  value: string;
  onChange: (alias: string) => void;
  projects: ProjectRegistryEntry[];
  disabled?: boolean;
  id?: string;
}) {
  const loading = projects.length === 0;

  return (
    <select
      id={id}
      value={loading ? '' : value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
      disabled={disabled || loading}
    >
      {loading ? (
        <option value="">Loading projects…</option>
      ) : (
        projects.map((p) => (
          <option key={p.alias} value={p.alias}>
            {p.alias}
            {p.isDefault ? ' (default)' : ''}
          </option>
        ))
      )}
    </select>
  );
}
