// Focused tests for the streaming `<think>` stripper used in GroqProvider.
//
// Regression context: Groq's streaming endpoint, with default
// `reasoning_format: 'raw'`, interleaves `<think>…</think>` blocks into
// `delta.content`. The old streaming path forwarded every delta straight to
// the handler, so SentenceFlusher would enqueue the model's internal monologue
// to TTS and the avatar would audibly read its own reasoning. We now set
// `reasoning_format: 'hidden'` as the primary defense and run this stripper as
// belt-and-suspenders.
//
// These tests pin down the subtle cases: tags split across pushes, multiple
// blocks in one pipe, malformed (unclosed) blocks, and look-behind windows
// where a partial prefix at a chunk boundary must NOT be emitted.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { createThinkStripper } from './GroqProvider';

describe('createThinkStripper', () => {
  it('passes content through unchanged when there are no think blocks', () => {
    const s = createThinkStripper();
    const chunks = ['hello', ' ', 'world', '!'];
    let out = '';
    for (const c of chunks) {
      out += s.push(c);
    }
    out += s.end();
    expect(out).toBe('hello world!');
  });

  it('strips a single fully-contained <think> block within one push', () => {
    const s = createThinkStripper();
    const out = s.push('before<think>secret reasoning</think>after') + s.end();
    expect(out).toBe('beforeafter');
  });

  it('handles a think block whose open/close tags straddle chunk boundaries', () => {
    const s = createThinkStripper();
    // The most common real-world case: Groq emits `<`, `think>`, body, `</`, `think>`,
    // etc. as separate SSE frames. Our stripper must suppress all of them and then
    // resume emitting normally.
    const chunks = ['prefix <', 'think', '>hidden', ' reasoning<', '/think>', 'visible tail'];
    let out = '';
    for (const c of chunks) {
      out += s.push(c);
    }
    out += s.end();
    expect(out).toBe('prefix visible tail');
  });

  it('strips multiple think blocks in the same stream', () => {
    const s = createThinkStripper();
    const out =
      s.push('a<think>one</think>b') +
      s.push('<think>two</think>c') +
      s.push('<think>three') +
      s.push('</think>d') +
      s.end();
    expect(out).toBe('abcd');
  });

  it('does NOT emit a partial <think prefix across a boundary', () => {
    // If the open tag is broken as `<thin` / `k>body</think>`, the stripper must
    // hold back `<thin` until it sees the next chunk — emitting it eagerly would
    // leak partial XML to TTS.
    const s = createThinkStripper();
    // Holdback window is OPEN.length - 1 = 6 chars. 'ok <thin' is 8 chars,
    // so we emit the first 2 (`'ok'`) and hold back the trailing `' <thin'`
    // in case the next chunk completes `<think>`.
    const a = s.push('ok <thin');
    expect(a).toBe('ok');
    const b = s.push('k>body</think> done');
    expect(a + b + s.end()).toBe('ok  done');
  });

  it('does NOT emit a partial </think prefix across a boundary', () => {
    const s = createThinkStripper();
    const a = s.push('pre<think>bod');
    expect(a).toBe('pre');
    // Break the close tag across chunks.
    const b = s.push('y</thi');
    expect(b).toBe(''); // still inside the think block
    const c = s.push('nk>post');
    expect(a + b + c + s.end()).toBe('prepost');
  });

  it('drops an unclosed <think> block at end-of-stream (intentional)', () => {
    // If the stream cuts off mid-thought (network drop, model truncation), speaking
    // the half-finished monologue would be worse than silence. Drop it.
    const s = createThinkStripper();
    const a = s.push('hello <think>i was thinking about');
    const b = s.end();
    expect(a + b).toBe('hello ');
  });

  it('flushes buffered tail content on end()', () => {
    // Up-to-(OPEN.length-1) = 6 chars are held back pending a potential `<think>`.
    // end() must release them when no tag materializes.
    const s = createThinkStripper();
    const a = s.push('finished.');
    expect(a).not.toBe('finished.'); // tail held back
    expect(a.length).toBeLessThan('finished.'.length);
    const b = s.end();
    expect(a + b).toBe('finished.');
  });

  it('handles think block at stream start', () => {
    const s = createThinkStripper();
    const out = s.push('<think>reason</think>answer') + s.end();
    expect(out).toBe('answer');
  });

  it('handles think block at stream end (closed)', () => {
    const s = createThinkStripper();
    const out = s.push('answer<think>reason</think>') + s.end();
    expect(out).toBe('answer');
  });

  it('preserves content with literal `<` that is not a think tag', () => {
    const s = createThinkStripper();
    const out = s.push('x < y && y > z') + s.end();
    expect(out).toBe('x < y && y > z');
  });
});
