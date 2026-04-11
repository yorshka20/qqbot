/** biome-ignore-all lint/suspicious/noArrayIndexKey: <explanation> */

export function QdrantPayloadView({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload);
  if (entries.length === 0) {
    return <span className="text-sm text-zinc-400">(empty payload)</span>;
  }

  return (
    <div className="space-y-2">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-2">
          <span className="shrink-0 text-xs font-medium text-indigo-600 dark:text-indigo-400 min-w-[100px] pt-0.5">
            {key}
          </span>
          <div className="flex-1 text-sm text-zinc-700 dark:text-zinc-300 break-all whitespace-pre-wrap">
            {renderQdrantValue(value)}
          </div>
        </div>
      ))}
    </div>
  );
}

function renderQdrantValue(value: unknown): string {
  if (value === null || value === undefined) return '(null)';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((v) => typeof v === 'string' || typeof v === 'number')) {
      return value.join(', ');
    }
    return JSON.stringify(value, null, 2);
  }
  return JSON.stringify(value, null, 2);
}
