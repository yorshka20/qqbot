import { describe, expect, it } from 'bun:test';
import { aggregateBatchSenders } from '../BilibiliLiveBridge';
import type { BufferEntry } from '../DanmakuBuffer';

function makeEntry(overrides: Partial<BufferEntry>): BufferEntry {
  const now = Date.now();
  return {
    normalizedText: overrides.rawText?.toLowerCase() ?? '',
    rawText: '',
    count: 1,
    senders: new Set<string>(),
    lastUsername: '',
    mentionsStreamer: false,
    rawEvents: [],
    firstSeenAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

describe('aggregateBatchSenders', () => {
  it('folds one entry with one sender into a single {uid, name, text}', () => {
    const out = aggregateBatchSenders([
      makeEntry({ rawText: '主播今天真好看', senders: new Set(['42']), lastUsername: '张三' }),
    ]);
    expect(out).toEqual([{ uid: '42', name: '张三', text: '主播今天真好看' }]);
  });

  it('merges multiple entries by the same uid, joining their raw texts with \\n', () => {
    const out = aggregateBatchSenders([
      makeEntry({ rawText: '第一条', senders: new Set(['42']), lastUsername: '张三' }),
      makeEntry({ rawText: '第二条', senders: new Set(['42']), lastUsername: '张三' }),
    ]);
    expect(out).toEqual([{ uid: '42', name: '张三', text: '第一条\n第二条' }]);
  });

  it('keeps distinct uids separate and preserves insertion order', () => {
    const out = aggregateBatchSenders([
      makeEntry({ rawText: 'a', senders: new Set(['111']), lastUsername: 'Alice' }),
      makeEntry({ rawText: 'b', senders: new Set(['222']), lastUsername: 'Bob' }),
    ]);
    expect(out.map((s) => s.uid)).toEqual(['111', '222']);
    expect(out[0].text).toBe('a');
    expect(out[1].text).toBe('b');
  });

  it('collapses an entry whose sender set has multiple uids into per-uid lines', () => {
    // Deduped entry shared by two speakers (e.g. "666" from two people).
    const out = aggregateBatchSenders([makeEntry({ rawText: '666', senders: new Set(['111', '222']) })]);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.text)).toEqual(['666', '666']);
  });

  it('takes the most recent lastUsername seen for a uid (later entries win)', () => {
    const out = aggregateBatchSenders([
      makeEntry({ rawText: 'x', senders: new Set(['42']), lastUsername: 'old-name' }),
      makeEntry({ rawText: 'y', senders: new Set(['42']), lastUsername: 'new-name' }),
    ]);
    expect(out[0].name).toBe('new-name');
  });

  it('keeps name empty when no entry carried a lastUsername', () => {
    const out = aggregateBatchSenders([makeEntry({ rawText: 'x', senders: new Set(['42']), lastUsername: '' })]);
    expect(out[0].name).toBe('');
  });

  it('drops falsy / empty uids defensively', () => {
    const out = aggregateBatchSenders([makeEntry({ rawText: 'x', senders: new Set(['', '42']) })]);
    expect(out.map((s) => s.uid)).toEqual(['42']);
  });
});
