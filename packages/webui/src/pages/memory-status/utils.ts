export function formatMemoryDate(ts: number): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatMemoryAge(days: number): string {
  if (days < 1) return '<1d';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}
