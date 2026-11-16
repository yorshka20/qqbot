import { describe, expect, test } from 'bun:test';
import { readSSE, type SSEMessage, SSEParser } from '../sse';

function bodyOf(chunks: Array<string | Uint8Array>, keepOpen = false): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
      }
      if (!keepOpen) {
        controller.close();
      }
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<SSEMessage[]> {
  const out: SSEMessage[] = [];
  for await (const message of readSSE(body, signal)) {
    out.push(message);
  }
  return out;
}

describe('SSEParser', () => {
  test('reads event and data, framed by a blank line', () => {
    expect(new SSEParser().feed('event: init\ndata: {"a":1}\n\n')).toEqual([{ event: 'init', data: '{"a":1}' }]);
  });

  test('holds a frame split across chunks until it is complete', () => {
    const parser = new SSEParser();
    expect(parser.feed('event: stage_st')).toEqual([]);
    expect(parser.feed('art\ndata: {"x"')).toEqual([]);
    expect(parser.feed(':2}\n')).toEqual([]);
    expect(parser.feed('\n')).toEqual([{ event: 'stage_start', data: '{"x":2}' }]);
  });

  test('joins repeated data lines with a newline', () => {
    expect(new SSEParser().feed('data: one\ndata: two\n\n')).toEqual([{ event: 'message', data: 'one\ntwo' }]);
  });

  test('does not leak the event name into the next frame', () => {
    expect(new SSEParser().feed('event: a\ndata: 1\n\ndata: 2\n\n')).toEqual([
      { event: 'a', data: '1' },
      { event: 'message', data: '2' },
    ]);
  });

  test('ignores comments, unknown fields and a frame without data', () => {
    expect(new SSEParser().feed(': keep-alive\n\nid: 7\nretry: 100\nevent: empty\n\n')).toEqual([]);
  });

  test('strips only one leading space of a value', () => {
    expect(new SSEParser().feed('data:  indented\ndata:tight\n\n')).toEqual([{ event: 'message', data: ' indented\ntight' }]);
  });

  test('accepts CRLF and lone CR line endings, even when CRLF is split across chunks', () => {
    const parser = new SSEParser();
    expect(parser.feed('data: x\r')).toEqual([]);
    expect(parser.feed('\n\r\n')).toEqual([{ event: 'message', data: 'x' }]);
    expect(parser.feed('event: y\rdata: z\r\r')).toEqual([]);
    expect(parser.feed('data: next')).toEqual([{ event: 'y', data: 'z' }]);
  });
});

describe('readSSE', () => {
  test('decodes a multi-byte character split across network chunks', async () => {
    const bytes = new TextEncoder().encode('event: complete\ndata: {"summary":"中文摘要"}\n\n');
    const cut = bytes.indexOf(0xe4) + 1;
    const messages = await collect(bodyOf([bytes.slice(0, cut), bytes.slice(cut)]));
    expect(messages).toEqual([{ event: 'complete', data: '{"summary":"中文摘要"}' }]);
  });

  test('yields every message until the body ends, dropping an unterminated tail', async () => {
    const messages = await collect(bodyOf(['event: a\ndata: 1\n\nevent: b\nda', 'ta: 2\n\nevent: c\ndata: 3\n']));
    expect(messages).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  test('stops when the signal aborts while the body stays open', async () => {
    const abort = new AbortController();
    const out: SSEMessage[] = [];
    for await (const message of readSSE(bodyOf(['data: first\n\n'], true), abort.signal)) {
      out.push(message);
      abort.abort();
    }
    expect(out).toEqual([{ event: 'message', data: 'first' }]);
  });

  test('cancels the body when the consumer leaves the loop early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: 1\n\ndata: 2\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const _message of readSSE(body)) {
      break;
    }
    expect(cancelled).toBe(true);
  });
});
