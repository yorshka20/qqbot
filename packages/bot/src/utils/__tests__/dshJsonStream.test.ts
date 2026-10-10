import { describe, expect, test } from 'bun:test';
import { parseDshJsonStream } from '../dshJsonStream';

describe('parseDshJsonStream', () => {
  test('reads the final event, which is the only uncapped copy of the answer', () => {
    const raw = [
      JSON.stringify({ type: 'session', sessionId: 'session-1' }),
      JSON.stringify({ type: 'text', text: 'working' }),
      JSON.stringify({ type: 'tool_call', tool: 'bash' }),
      JSON.stringify({ type: 'final', text: 'the answer' }),
    ].join('\n');
    expect(parseDshJsonStream(raw).finalMessage).toBe('the answer');
  });

  test('the last final event wins when a run emits more than one', () => {
    const raw = [JSON.stringify({ type: 'final', text: 'first' }), JSON.stringify({ type: 'final', text: 'second' })].join(
      '\n',
    );
    expect(parseDshJsonStream(raw).finalMessage).toBe('second');
  });

  test('a completed turn with an empty final event yields an empty message', () => {
    const raw = [JSON.stringify({ type: 'text', text: 'partial' }), JSON.stringify({ type: 'final', text: '' })].join(
      '\n',
    );
    expect(parseDshJsonStream(raw).finalMessage).toBe('');
  });

  test('falls back to the last text event when no final event arrives', () => {
    const raw = [JSON.stringify({ type: 'text', text: 'one' }), JSON.stringify({ type: 'text', text: 'two' })].join('\n');
    expect(parseDshJsonStream(raw).finalMessage).toBe('two');
  });

  test('a failed turn ending in an error status without final yields an empty message', () => {
    const raw = [
      JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'error', error: { code: 'X' } } }),
      JSON.stringify({ type: 'final', text: '' }),
    ].join('\n');
    expect(parseDshJsonStream(raw).finalMessage).toBe('');
  });

  test('non-JSON stdout is returned verbatim', () => {
    expect(parseDshJsonStream('plain output\n').finalMessage).toBe('plain output\n');
  });

  test('empty stdout yields an empty message', () => {
    expect(parseDshJsonStream('   \n ').finalMessage).toBe('');
  });

  test('JSON-ish input with no parseable event degrades to the raw string', () => {
    expect(parseDshJsonStream('{not json}').finalMessage).toBe('{not json}');
  });

  test('exposes the parsed events alongside the message', () => {
    const raw = [JSON.stringify({ type: 'status', phase: 'turn_start' }), JSON.stringify({ type: 'final', text: 'ok' })].join(
      '\n',
    );
    expect(parseDshJsonStream(raw).rawEvents).toHaveLength(2);
  });
});
