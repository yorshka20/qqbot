import type { ReactNode } from 'react';

export function HighlightText({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) {
    return <>{text}</>;
  }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'ig'));
  if (parts.length === 1) {
    return <>{text}</>;
  }
  const lower = needle.toLowerCase();
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const part of parts) {
    const key = `${offset}:${part}`;
    if (part.toLowerCase() === lower) {
      nodes.push(
        <mark key={key} className="bg-amber-200/80 dark:bg-amber-400/25 text-inherit rounded-sm px-0.5">
          {part}
        </mark>,
      );
    } else {
      nodes.push(<span key={key}>{part}</span>);
    }
    offset += part.length;
  }
  return <>{nodes}</>;
}
