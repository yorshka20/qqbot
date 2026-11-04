import type { ClusterHelpRequest } from '@qqbot/api-types';
import { describe, expect, test } from 'bun:test';
import { groupInboxByDay, type InboxItem } from './inbox';

const NOW = new Date(2026, 10, 4, 12, 0).getTime();

function askItem(key: string, since: number): InboxItem {
  const help: ClusterHelpRequest = {
    id: key,
    workerId: 'w1',
    type: 'decision',
    question: '选哪个？',
    status: 'pending',
    createdAt: new Date(since).toISOString(),
  };
  return { kind: 'ask', key, help, since };
}

describe('groupInboxByDay', () => {
  test('splits items across two days into two groups, oldest day first', () => {
    const groups = groupInboxByDay(
      [askItem('today', new Date(2026, 10, 4, 9, 0).getTime()), askItem('yesterday', new Date(2026, 10, 3, 9, 0).getTime())],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(['昨天', '今天']);
    expect(groups.map((g) => g.items.map((i) => i.key))).toEqual([['yesterday'], ['today']]);
  });

  test('keeps multiple same-day items in one group, in the order given', () => {
    const groups = groupInboxByDay(
      [askItem('a', new Date(2026, 10, 4, 9, 0).getTime()), askItem('b', new Date(2026, 10, 4, 10, 0).getTime())],
      NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.key)).toEqual(['a', 'b']);
  });

  test('an empty list groups to an empty list', () => {
    expect(groupInboxByDay([], NOW)).toEqual([]);
  });
});
