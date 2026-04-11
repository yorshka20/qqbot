import { ChevronDown, ChevronRight } from 'lucide-react';

import type { InsightDetail, InsightListItem } from '../../../types';
import { InsightDetailView } from './InsightDetailView';

export function InsightRow({
  item,
  expanded,
  detail,
  detailLoading,
  onToggle,
}: {
  item: InsightListItem;
  expanded: boolean;
  detail: InsightDetail | null;
  detailLoading: boolean;
  onToggle: () => void;
}) {
  const time = new Date(item.analyzedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 shrink-0 text-zinc-400" />
        ) : (
          <ChevronRight className="w-4 h-4 shrink-0 text-zinc-400" />
        )}

        <span
          className={`shrink-0 w-2 h-2 rounded-full ${
            item.worthReporting ? 'bg-green-500' : 'bg-zinc-300 dark:bg-zinc-600'
          }`}
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{item.title}</span>
          </div>
          {item.headline && <p className="text-sm text-zinc-500 dark:text-zinc-400 truncate mt-0.5">{item.headline}</p>}
        </div>

        <div className="shrink-0 flex items-center gap-3 text-xs text-zinc-400 dark:text-zinc-500">
          <span>{item.source}</span>
          <span>{item.itemCount} 条</span>
          <span>{time}</span>
        </div>
      </button>

      {!expanded && item.categoryTags.length > 0 && (
        <div className="px-4 pb-2 flex flex-wrap gap-1">
          {item.categoryTags.map((tag) => (
            <span
              key={tag}
              className="px-2 py-0.5 text-xs rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {expanded && (
        <div className="border-t border-zinc-200 dark:border-zinc-700 px-4 py-4 bg-zinc-50/50 dark:bg-zinc-800/30">
          {detailLoading && <div className="text-sm text-zinc-400">加载详情...</div>}
          {detail && <InsightDetailView detail={detail} />}
        </div>
      )}
    </div>
  );
}
