// Tests for DanmakuBuffer aggregation / dedup / mention detection.
// Avoids timers by calling flushNow() directly instead of relying on the
// 3s tick.

import { describe, expect, it } from 'bun:test';
import type { DanmakuEvent } from '../BilibiliLiveClient';
import { DanmakuBuffer, detectMention, normalizeText } from '../DanmakuBuffer';

function evt(partial: Partial<DanmakuEvent> & { uid: string; text: string }): DanmakuEvent {
  return {
    username: partial.username ?? `user${partial.uid}`,
    timestamp: partial.timestamp ?? Date.now(),
    ...partial,
  };
}

describe('normalizeText', () => {
  it('trims, collapses whitespace, lowercases', () => {
    expect(normalizeText('  HELLO  World   ')).toBe('hello world');
    expect(normalizeText('\t\n\n666')).toBe('666');
    expect(normalizeText('')).toBe('');
  });
});

describe('detectMention', () => {
  it('returns false for empty alias list', () => {
    expect(detectMention('hello ava', [])).toBe(false);
    expect(detectMention('hello ava', undefined)).toBe(false);
  });

  it('matches substring case-insensitively', () => {
    expect(detectMention('嘿 ava 看我', ['Ava'])).toBe(true);
    expect(detectMention('阿娃娃真可爱', ['阿娃'])).toBe(true);
    expect(detectMention('no mention here', ['Ava', '阿娃'])).toBe(false);
  });

  it('ignores empty alias entries', () => {
    expect(detectMention('hello', ['', '  '])).toBe(false);
  });
});

describe('DanmakuBuffer', () => {
  it('skips flush when buffer is empty', () => {
    const buf = new DanmakuBuffer();
    expect(buf.flushNow()).toBeNull();
  });

  it('dedups identical normalized text from distinct senders', () => {
    const buf = new DanmakuBuffer();
    buf.push(evt({ uid: '1', text: '666' }));
    buf.push(evt({ uid: '2', text: '666' }));
    buf.push(evt({ uid: '3', text: '  666 ' })); // normalizes to the same key
    const payload = buf.flushNow();
    expect(payload).not.toBeNull();
    expect(payload!.entries.length).toBe(1);
    expect(payload!.entries[0].count).toBe(3);
    expect(payload!.entries[0].senders.size).toBe(3);
    expect(payload!.totalDanmaku).toBe(3);
    expect(payload!.distinctSenders).toBe(3);
  });

  it('keeps distinct entries for different texts', () => {
    const buf = new DanmakuBuffer();
    buf.push(evt({ uid: '1', text: 'hello' }));
    buf.push(evt({ uid: '2', text: '666' }));
    const payload = buf.flushNow();
    expect(payload!.entries.length).toBe(2);
    expect(payload!.totalDanmaku).toBe(2);
  });

  it('flags mentionsStreamer when any matching raw event hits the alias list', () => {
    const buf = new DanmakuBuffer({ streamerAliases: ['Ava'] });
    buf.push(evt({ uid: '1', text: 'hey ava' }));
    buf.push(evt({ uid: '2', text: 'hey ava' }));
    const payload = buf.flushNow();
    expect(payload!.anyMention).toBe(true);
    expect(payload!.entries[0].mentionsStreamer).toBe(true);
  });

  it('clears state after flush so the next window starts empty', () => {
    const buf = new DanmakuBuffer();
    buf.push(evt({ uid: '1', text: 'first' }));
    expect(buf.flushNow()).not.toBeNull();
    expect(buf.flushNow()).toBeNull();
  });

  it('drops entries whose normalized text is empty', () => {
    const buf = new DanmakuBuffer();
    buf.push(evt({ uid: '1', text: '' }));
    buf.push(evt({ uid: '2', text: '   \n' }));
    expect(buf.flushNow()).toBeNull();
  });

  it('truncates overlong text', () => {
    const buf = new DanmakuBuffer({ maxTextLen: 5 });
    buf.push(evt({ uid: '1', text: 'abcdefghij' }));
    const payload = buf.flushNow();
    expect(payload!.entries[0].rawText).toBe('abcde');
  });

  it('emits flush with a formatted summary matching the expected shape', () => {
    const buf = new DanmakuBuffer({ flushIntervalMs: 3000 });
    buf.push(evt({ uid: '1', username: 'alice', text: '你好' }));
    buf.push(evt({ uid: '2', username: 'bob', text: '666' }));
    buf.push(evt({ uid: '3', username: 'carol', text: '666' }));
    const payload = buf.flushNow()!;
    expect(payload.summaryText).toContain('[直播间弹幕 · 过去3秒 · 3条 · 3人]');
    expect(payload.summaryText).toContain('666');
    expect(payload.summaryText).toMatch(/x2|x3/); // 666 repeated
  });
});
