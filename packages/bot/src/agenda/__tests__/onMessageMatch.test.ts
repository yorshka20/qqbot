import { describe, expect, it } from 'bun:test';
import { matchOnMessageEvent, parseWatchKeywords } from '../onMessageMatch';
import type { AgendaItem, AgendaSystemEvent } from '../types';

const BOT_ID = '10000';

function makeItem(overrides: Partial<AgendaItem>): AgendaItem {
  return {
    id: 'item-1',
    name: 'test watch',
    userId: '20001',
    groupId: '30001',
    triggerType: 'onMessage',
    intent: 'do something',
    cooldownMs: 60_000,
    maxSteps: 15,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as AgendaItem;
}

function makeEvent(overrides: Partial<AgendaSystemEvent>): AgendaSystemEvent {
  return {
    type: 'message_received',
    groupId: '30001',
    userId: '20002',
    botSelfId: BOT_ID,
    data: { text: 'hello world' },
    ...overrides,
  };
}

describe('parseWatchKeywords', () => {
  it('parses a JSON string array', () => {
    expect(parseWatchKeywords('["开饭","比赛"]')).toEqual(['开饭', '比赛']);
  });

  it('returns [] for undefined, malformed JSON, and non-arrays', () => {
    expect(parseWatchKeywords(undefined)).toEqual([]);
    expect(parseWatchKeywords('not json')).toEqual([]);
    expect(parseWatchKeywords('{"a":1}')).toEqual([]);
  });

  it('drops non-string and empty entries', () => {
    expect(parseWatchKeywords('["ok", "", 3, null, "  "]')).toEqual(['ok']);
  });
});

describe('matchOnMessageEvent', () => {
  it('matches when a keyword is contained (case-insensitive)', () => {
    const item = makeItem({ watchKeywords: '["开饭","Match"]' });
    const result = matchOnMessageEvent(item, ['开饭', 'Match'], makeEvent({ data: { text: '大家准备MATCH了吗' } }));
    expect(result.matched).toBe(true);
    expect(result.matchedKeyword).toBe('Match');
  });

  it('never matches the bot own messages', () => {
    const item = makeItem({ watchKeywords: '["开饭"]' });
    const event = makeEvent({ userId: BOT_ID, data: { text: '开饭了' } });
    expect(matchOnMessageEvent(item, ['开饭'], event).matched).toBe(false);
  });

  it('ignores keywords inside machine tokens like [Image:...]', () => {
    const item = makeItem({ watchKeywords: '["动画"]' });
    const event = makeEvent({ data: { text: '[Image:[动画表情]]' } });
    expect(matchOnMessageEvent(item, ['动画'], event).matched).toBe(false);
  });

  it('scopes group items to their group only', () => {
    const item = makeItem({ watchKeywords: '["开饭"]', groupId: '30001' });
    const otherGroup = makeEvent({ groupId: '99999', data: { text: '开饭' } });
    expect(matchOnMessageEvent(item, ['开饭'], otherGroup).matched).toBe(false);
  });

  it('scopes items without a group to the creator private chat', () => {
    const item = makeItem({ watchKeywords: '["开饭"]', groupId: undefined, userId: '20001' });
    const ownPrivate = makeEvent({ groupId: '', userId: '20001', data: { text: '开饭' } });
    const otherPrivate = makeEvent({ groupId: '', userId: '20002', data: { text: '开饭' } });
    const groupMessage = makeEvent({ groupId: '30001', userId: '20001', data: { text: '开饭' } });
    expect(matchOnMessageEvent(item, ['开饭'], ownPrivate).matched).toBe(true);
    expect(matchOnMessageEvent(item, ['开饭'], otherPrivate).matched).toBe(false);
    expect(matchOnMessageEvent(item, ['开饭'], groupMessage).matched).toBe(false);
  });

  it('matches by watchUserId without keywords', () => {
    const item = makeItem({ watchUserId: '20002' });
    expect(matchOnMessageEvent(item, [], makeEvent({ userId: '20002' })).matched).toBe(true);
    expect(matchOnMessageEvent(item, [], makeEvent({ userId: '20003' })).matched).toBe(false);
  });

  it('requires both watchUserId and keyword when both are set', () => {
    const item = makeItem({ watchUserId: '20002', watchKeywords: '["开饭"]' });
    expect(matchOnMessageEvent(item, ['开饭'], makeEvent({ userId: '20002', data: { text: '开饭' } })).matched).toBe(
      true,
    );
    expect(matchOnMessageEvent(item, ['开饭'], makeEvent({ userId: '20003', data: { text: '开饭' } })).matched).toBe(
      false,
    );
    expect(matchOnMessageEvent(item, ['开饭'], makeEvent({ userId: '20002', data: { text: '别的' } })).matched).toBe(
      false,
    );
  });

  it('never matches when there is no watch condition', () => {
    const item = makeItem({});
    expect(matchOnMessageEvent(item, [], makeEvent({})).matched).toBe(false);
  });
});
