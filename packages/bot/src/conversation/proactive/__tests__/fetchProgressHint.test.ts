// The hint used to depend on a shared notifier whose target chat was set by a call that no
// longer exists, so it never fired. It is now bound to its chat when it is created.

import { describe, expect, it } from 'bun:test';
import { fetchProgressHint } from '../fetchProgressHint';

describe('fetchProgressHint', () => {
  it('sends one message listing every title through the bound sender', () => {
    const sent: string[] = [];
    const hint = fetchProgressHint(async (text) => {
      sent.push(text);
    });

    hint.onFetchingUrls(['测试文章甲', '测试文章乙']);

    expect(sent).toEqual(['正在查询：\n- 测试文章甲\n- 测试文章乙']);
  });

  it('stays silent when there is nothing to fetch', () => {
    const sent: string[] = [];
    const hint = fetchProgressHint(async (text) => {
      sent.push(text);
    });

    hint.onFetchingUrls([]);

    expect(sent).toEqual([]);
  });

  it('keeps each hint with the chat it was created for', () => {
    const sent: Array<[number, string]> = [];
    const hintFor = (groupId: number) =>
      fetchProgressHint(async (text) => {
        sent.push([groupId, text]);
      });
    const first = hintFor(10000001);
    const second = hintFor(10000002);

    second.onFetchingUrls(['乙']);
    first.onFetchingUrls(['甲']);

    expect(sent).toEqual([
      [10000002, '正在查询：\n- 乙'],
      [10000001, '正在查询：\n- 甲'],
    ]);
  });

  it('does not let a failed send escape into the fetch', async () => {
    const hint = fetchProgressHint(() => Promise.reject(new Error('send failed')));

    expect(() => hint.onFetchingUrls(['甲'])).not.toThrow();
    await Promise.resolve();
  });
});
