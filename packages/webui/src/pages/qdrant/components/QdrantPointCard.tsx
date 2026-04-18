import { QdrantPayloadView } from './PayloadView';

export function QdrantPointCard({
  id,
  payload,
  score,
  expanded,
  onToggle,
}: {
  id: string | number;
  payload: Record<string, unknown>;
  score?: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const content = (payload.content as string) ?? '';
  const preview = content.length > 200 ? `${content.slice(0, 200)}...` : content;

  return (
    <div className="bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-750 transition-colors"
      >
        <span className="text-xs font-mono text-zinc-400 dark:text-zinc-500 shrink-0 max-w-[180px] truncate">
          {String(id)}
        </span>
        {score != null && (
          <span className="shrink-0 px-2 py-0.5 text-xs font-medium rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300">
            {score.toFixed(4)}
          </span>
        )}
        <span className="flex-1 text-sm text-zinc-700 dark:text-zinc-300 truncate">{preview || '(no content)'}</span>
        <span className="text-xs text-zinc-400 shrink-0">{expanded ? '收起' : '展开'}</span>
      </button>

      {expanded && (
        <div className="border-t border-zinc-100 dark:border-zinc-700 px-4 py-3">
          <QdrantPayloadView payload={payload} />
        </div>
      )}
    </div>
  );
}
