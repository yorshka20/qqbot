import { describe, expect, test } from 'bun:test';
import { SSEParser } from './sse';

describe('SSEParser', () => {
  test('reads event and data, framed by a blank line', () => {
    expect(new SSEParser().feed('event: init\ndata: {"a":1}\n\n')).toEqual([{ event: 'init', data: '{"a":1}' }]);
  });

  test('holds a frame split across chunks until it is complete', () => {
    const parser = new SSEParser();
    expect(parser.feed('event: task_out')).toEqual([]);
    expect(parser.feed('put\ndata: {"x"')).toEqual([]);
    expect(parser.feed(':2}\n')).toEqual([]);
    expect(parser.feed('\n')).toEqual([{ event: 'task_output', data: '{"x":2}' }]);
  });

  test('joins repeated data lines with a newline', () => {
    expect(new SSEParser().feed('data: one\ndata: two\n\n')).toEqual([{ event: 'message', data: 'one\ntwo' }]);
  });

  test('returns every frame of a chunk and does not leak the event name into the next', () => {
    expect(new SSEParser().feed('event: a\ndata: 1\n\ndata: 2\n\n')).toEqual([
      { event: 'a', data: '1' },
      { event: 'message', data: '2' },
    ]);
  });

  test('ignores comments and a frame without data', () => {
    expect(new SSEParser().feed(': keep-alive\n\nevent: empty\n\n')).toEqual([]);
  });

  test('accepts CRLF even when the pair is split across chunks', () => {
    const parser = new SSEParser();
    expect(parser.feed('data: x\r')).toEqual([]);
    expect(parser.feed('\n\r\n')).toEqual([{ event: 'message', data: 'x' }]);
  });
});
