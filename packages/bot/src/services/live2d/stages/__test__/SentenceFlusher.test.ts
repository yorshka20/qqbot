import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { SentenceFlusher } from '../SentenceFlusher';

function collectChunks(inputs: string[], opts?: { minCharsForSeparator?: number }): string[] {
  const out: string[] = [];
  const f = new SentenceFlusher((c) => out.push(c), opts);
  for (const i of inputs) f.push(i);
  f.end();
  return out;
}

describe('SentenceFlusher', () => {
  it('flushes on Chinese full-stop terminator', () => {
    const chunks = collectChunks(['你', '好啊', '。还好', '吗？']);
    expect(chunks).toEqual(['你好啊。', '还好吗？']);
  });

  it('flushes on English period terminator', () => {
    const chunks = collectChunks(['Hello world.', ' Good day.']);
    expect(chunks).toEqual(['Hello world.', ' Good day.']);
  });

  it('does not flush below min-chars without terminator', () => {
    const chunks = collectChunks(['短的，没问题']);
    expect(chunks).toEqual(['短的，没问题']);
  });

  it('flushes on clause separator once over min-chars', () => {
    // First 20+ chars with a 、 separator → flush at the separator.
    const first = '这是一个比较长的半句内容、然后继续写更多东西最终才结束';
    const chunks = collectChunks([first], { minCharsForSeparator: 20 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].endsWith('、')).toBe(true);
  });

  it('does not flush inside an unclosed LIVE2D tag', () => {
    // End-of-stream flush must include the partial tag verbatim since we
    // never got a close bracket — but mid-stream, flushing stops at the
    // open bracket.
    const out: string[] = [];
    const f = new SentenceFlusher((c) => out.push(c));
    f.push('你好啊。[LIVE2D: emotion=happy');
    // Should have emitted the sentence BEFORE the open bracket. The tag
    // portion sits in the buffer awaiting close.
    expect(out).toEqual(['你好啊。']);
    f.push(', action=wave, intensity=0.8]再见。');
    expect(out.length).toBe(2);
    expect(out[1]).toContain('[LIVE2D:');
    expect(out[1]).toContain('再见。');
  });

  it('end() flushes remaining buffer', () => {
    const chunks = collectChunks(['没有终止符的尾巴']);
    expect(chunks).toEqual(['没有终止符的尾巴']);
  });

  it('end() with empty/whitespace-only buffer emits nothing', () => {
    const chunks = collectChunks(['   ', ' ']);
    expect(chunks).toEqual([]);
  });

  it('handles multiple sentences in one chunk', () => {
    const chunks = collectChunks(['第一句。第二句！第三句？']);
    expect(chunks).toEqual(['第一句。', '第二句！', '第三句？']);
  });
});
