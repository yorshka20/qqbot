/**
 * Group list items by zh-CN calendar date key, most recent first.
 * Date labels use 今天 / 昨天 / long form for older days (matches Insights & Zhihu pages).
 */
export function groupByZhLocaleDate<T>(
  items: T[],
  getDate: (item: T) => Date,
): Array<{ dateKey: string; label: string; items: T[] }> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const d = getDate(item);
    const key = d.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const arr = map.get(key);
    if (arr) arr.push(item);
    else map.set(key, [item]);
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([dateKey, groupItems]) => ({
      dateKey,
      label: relativeZhDayLabel(getDate(groupItems[0])),
      items: groupItems,
    }));
}

function relativeZhDayLabel(d: Date): string {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const key = d.toDateString();
  if (key === today.toDateString()) return '今天';
  if (key === yesterday.toDateString()) return '昨天';
  return d.toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
}
