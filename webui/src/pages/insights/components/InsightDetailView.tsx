import { ExternalLink, Tag } from 'lucide-react';

import type { InsightDetail } from '../../../types';
import { cleanWxUrl } from '../utils';

const IMPORTANCE_COLORS: Record<string, string> = {
  high: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  low: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
};

const TYPE_LABELS: Record<string, string> = {
  fact: '事实',
  opinion: '观点',
  news: '新闻',
  insight: '洞察',
};

export function InsightDetailView({ detail }: { detail: InsightDetail }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm">
        <span className="text-zinc-500 dark:text-zinc-400">来源: {detail.source}</span>
        <span className="text-zinc-500 dark:text-zinc-400">模型: {detail.model}</span>
        {detail.url && (
          <a
            href={cleanWxUrl(detail.url)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
          >
            原文 <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      {detail.categoryTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {detail.categoryTags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400"
            >
              <Tag className="w-3 h-3" />
              {tag}
            </span>
          ))}
        </div>
      )}

      {detail.items.length > 0 && (
        <div className="space-y-2">
          {detail.items.map((item) => (
            <div
              key={`${item.type}-${item.content.slice(0, 40)}`}
              className="flex gap-3 p-3 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700"
            >
              <div className="shrink-0 flex flex-col items-center gap-1">
                <span
                  className={`px-2 py-0.5 text-xs rounded font-medium ${IMPORTANCE_COLORS[item.importance] ?? IMPORTANCE_COLORS.low}`}
                >
                  {item.importance}
                </span>
                <span className="text-xs text-zinc-400">{TYPE_LABELS[item.type] ?? item.type}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm leading-relaxed">{item.content}</p>
                {item.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {item.tags.map((tag) => (
                      <span
                        key={tag}
                        className="px-1.5 py-0.5 text-xs rounded bg-zinc-100 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {detail.items.length === 0 && <p className="text-sm text-zinc-400">无提取内容（可能文章内容不足）</p>}
    </div>
  );
}
