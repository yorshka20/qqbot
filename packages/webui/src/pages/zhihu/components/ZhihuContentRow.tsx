import { ExternalLink, MessageSquare, ThumbsUp } from 'lucide-react';

import type { ZhihuContentListItem } from '../../../types';

export function ZhihuContentRow({ item }: { item: ZhihuContentListItem }) {
  const time = new Date(item.createdTime * 1000).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden px-4 py-3 space-y-2">
      <div className="flex items-center gap-3">
        <span
          className={`shrink-0 px-1.5 py-0.5 text-xs rounded font-medium ${
            item.targetType === 'article'
              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400'
              : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
          }`}
        >
          {item.targetType === 'article' ? '文章' : '回答'}
        </span>

        <div className="flex-1 min-w-0">
          <span className="font-medium truncate block">{item.title}</span>
          {item.questionTitle && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400 truncate mt-0.5">问题: {item.questionTitle}</p>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-3 text-xs text-zinc-400 dark:text-zinc-500">
          <span>{item.authorName}</span>
          <span className="inline-flex items-center gap-0.5">
            <ThumbsUp className="w-3 h-3" />
            {item.voteupCount}
          </span>
          <span className="inline-flex items-center gap-0.5">
            <MessageSquare className="w-3 h-3" />
            {item.commentCount}
          </span>
          <span>{time}</span>
        </div>
      </div>

      {item.excerpt && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed line-clamp-3">{item.excerpt}</p>
      )}

      {item.url && (
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          查看原文 <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </div>
  );
}
