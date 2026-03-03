/**
 * Unit tests for LLM JSON extraction (extractJsonFromLlmText, parseLlmJson, parseSearchDecision).
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { extractJsonFromLlmText, parseLlmJson, parseSearchDecision } from './llmJsonExtract';

describe('extractJsonFromLlmText', () => {
  test('extracts plain JSON object', () => {
    const text = '{"a": 1, "b": "two"}';
    const result = extractJsonFromLlmText(text);
    expect(result).not.toBeNull();
    if (result == null) {
      return;
    }
    expect(JSON.parse(result)).toEqual({ a: 1, b: 'two' });
  });

  test('extracts JSON from markdown code block', () => {
    const text = 'Here is the result:\n```json\n{"keepIndices": [0, 2, 4]}\n```';
    const result = extractJsonFromLlmText(text);
    expect(result).not.toBeNull();
    if (result == null) {
      return;
    }
    expect(JSON.parse(result)).toEqual({ keepIndices: [0, 2, 4] });
  });

  test('extracts JSON after ANSWER: marker', () => {
    const text = 'Let me think...\nANSWER:\n{"shouldJoin": true, "reason": "ok"}';
    const result = extractJsonFromLlmText(text);
    expect(result).not.toBeNull();
    if (result == null) {
      return;
    }
    expect(JSON.parse(result)).toEqual({ shouldJoin: true, reason: 'ok' });
  });

  test('extracts JSON after ANSWER: with code block inside', () => {
    const text = 'ANSWER:\n```json\n{"tasks": []}\n```';
    const result = extractJsonFromLlmText(text);
    expect(result).not.toBeNull();
    if (result == null) {
      return;
    }
    expect(JSON.parse(result)).toEqual({ tasks: [] });
  });

  test('extracts JSON using brace-balanced strategy when reasoning precedes', () => {
    const text = 'First I considered the options. Then I decided.\n{"tasks": [{"type": "reply", "parameters": {}}]}';
    const result = extractJsonFromLlmText(text);
    expect(result).not.toBeNull();
    if (result == null) {
      return;
    }
    const parsed = JSON.parse(result);
    expect(parsed.tasks).toBeDefined();
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].type).toBe('reply');
  });

  test('extracts single-line JSON', () => {
    const text = 'Some intro\n\n{"key": "value"}\n\nTrailing';
    const result = extractJsonFromLlmText(text);
    expect(result).not.toBeNull();
    if (result == null) {
      return;
    }
    expect(JSON.parse(result)).toEqual({ key: 'value' });
  });

  test('returns null for empty string', () => {
    expect(extractJsonFromLlmText('')).toBeNull();
    expect(extractJsonFromLlmText('   ')).toBeNull();
  });

  test('returns null when no valid JSON object', () => {
    expect(extractJsonFromLlmText('hello world')).toBeNull();
    expect(extractJsonFromLlmText('["array only"]')).toBeNull();
  });

  test('respects strategy subset', () => {
    // Only regex strategy: ANSWER: and code block are skipped
    const textWithAnswer = 'ANSWER:\n{"x": 1}';
    const withAll = extractJsonFromLlmText(textWithAnswer);
    expect(withAll).not.toBeNull();

    const regexOnly = extractJsonFromLlmText(textWithAnswer, { strategies: ['regex'] });
    expect(regexOnly).not.toBeNull();
    if (regexOnly != null) {
      expect(JSON.parse(regexOnly)).toEqual({ x: 1 });
    }

    const codeBlockOnly = extractJsonFromLlmText(textWithAnswer, { strategies: ['codeBlock'] });
    expect(codeBlockOnly).toBeNull();
  });

  test('respects custom marker option', () => {
    const text = 'Result:\n{"n": 42}';
    const withAnswerOnly = extractJsonFromLlmText(text, { strategies: ['answer'] });
    expect(withAnswerOnly).toBeNull();

    const custom = extractJsonFromLlmText(text, {
      strategies: ['answer'],
      marker: /Result:\s*([\s\S]*?)(?:\n\n|$)/,
    });
    expect(custom).not.toBeNull();
    if (custom != null) {
      expect(JSON.parse(custom)).toEqual({ n: 42 });
    }
  });

  test('extracts last brace-balanced object when multiple JSON-like fragments exist', () => {
    const text = '{"a": 1} and then {"b": 2, "c": 3}';
    const result = extractJsonFromLlmText(text);
    expect(result).not.toBeNull();
    if (result != null) {
      expect(JSON.parse(result)).toEqual({ b: 2, c: 3 });
    }
  });

  test('code block without json tag still extracts', () => {
    const text = '```\n{"raw": true}\n```';
    const result = extractJsonFromLlmText(text);
    expect(result).not.toBeNull();
    if (result != null) {
      expect(JSON.parse(result)).toEqual({ raw: true });
    }
  });
});

describe('parseLlmJson', () => {
  const KeepIndicesSchema = z.object({ keepIndices: z.array(z.number()) }).transform((o) => o.keepIndices);

  test('extracts and parses to typed value with schema', () => {
    const text = '```json\n{"keepIndices": [0, 1, 3]}\n```';
    const result = parseLlmJson(text, KeepIndicesSchema);
    expect(result).toEqual([0, 1, 3]);
  });

  test('returns null when extraction fails', () => {
    const Schema = z.object({ value: z.number() });
    const result = parseLlmJson('no json here', Schema);
    expect(result).toBeNull();
  });

  test('returns null when schema validation fails', () => {
    const Schema = z.object({ required: z.string() });
    const result = parseLlmJson('{"wrong": "shape"}', Schema);
    expect(result).toBeNull();
  });

  test('returns null for invalid JSON after extraction', () => {
    const Schema = z.object({ a: z.number() });
    const result = parseLlmJson('{"unclosed', Schema);
    expect(result).toBeNull();
  });

  test('passes ExtractOptions to extraction', () => {
    const Schema = z.object({ id: z.number() });
    const text = 'ANSWER:\n{"id": 99}';
    const withOptions = parseLlmJson(text, Schema, { strategies: ['answer', 'codeBlock'] });
    expect(withOptions).toEqual({ id: 99 });
  });
});

describe('parseSearchDecision', () => {
  test('parses JSON output when valid', () => {
    const json = '{"needsSearch": true, "query": "test query", "isMultiSearch": false}';
    const result = parseSearchDecision(json);
    expect(result).toEqual({
      needsSearch: true,
      query: 'test query',
      isMultiSearch: false,
    });
  });

  test('parses JSON with queries array (multi-search)', () => {
    const json = `{"needsSearch": true, "queries": [{"query": "q1", "explanation": "e1"}, {"query": "q2", "explanation": "e2"}], "isMultiSearch": true}`;
    const result = parseSearchDecision(json);
    expect(result).toEqual({
      needsSearch: true,
      queries: [
        { query: 'q1', explanation: 'e1' },
        { query: 'q2', explanation: 'e2' },
      ],
      isMultiSearch: true,
    });
  });

  test('parses NO_SEARCH plain text', () => {
    expect(parseSearchDecision('NO_SEARCH')).toEqual({
      needsSearch: false,
      isMultiSearch: false,
    });
    expect(parseSearchDecision('no_search')).toEqual({
      needsSearch: false,
      isMultiSearch: false,
    });
    expect(parseSearchDecision('Something else entirely')).toEqual({
      needsSearch: false,
      isMultiSearch: false,
    });
  });

  test('parses SEARCH: plain text', () => {
    const result = parseSearchDecision('SEARCH: 明日方舟终末地最新情报');
    expect(result).toEqual({
      needsSearch: true,
      query: '明日方舟终末地最新情报',
      isMultiSearch: false,
    });
  });

  test('parses SEARCH: case-insensitively', () => {
    const result = parseSearchDecision('search: hello world');
    expect(result).toEqual({
      needsSearch: true,
      query: 'hello world',
      isMultiSearch: false,
    });
  });

  test('parses SEARCH: with empty query as needsSearch false', () => {
    const result = parseSearchDecision('SEARCH:   ');
    expect(result).toEqual({
      needsSearch: false,
      query: undefined,
      isMultiSearch: false,
    });
  });

  test('parses MULTI_SEARCH plain text with 查询N: format', () => {
    const text = `MULTI_SEARCH:
查询1: 关键词一 | 第一个查询说明
查询2: 关键词二 | 第二个说明`;
    const result = parseSearchDecision(text);
    expect(result.needsSearch).toBe(true);
    expect(result.isMultiSearch).toBe(true);
    expect(result.queries).toHaveLength(2);
    expect(result.queries?.[0]).toEqual({ query: '关键词一', explanation: '第一个查询说明' });
    expect(result.queries?.[1]).toEqual({ query: '关键词二', explanation: '第二个说明' });
  });

  test('parses MULTI_SEARCH case-insensitively', () => {
    const text = 'multi_search:\n查询1: foo | bar';
    const result = parseSearchDecision(text);
    expect(result.needsSearch).toBe(true);
    expect(result.isMultiSearch).toBe(true);
    expect(result.queries).toEqual([{ query: 'foo', explanation: 'bar' }]);
  });

  test('MULTI_SEARCH fallback for non-matching lines uses whole line as query', () => {
    const text = 'MULTI_SEARCH:\nplain line one\nplain line two';
    const result = parseSearchDecision(text);
    expect(result.queries).toHaveLength(2);
    expect(result.queries?.[0]).toEqual({ query: 'plain line one', explanation: 'Auto-extracted search query' });
    expect(result.queries?.[1]).toEqual({ query: 'plain line two', explanation: 'Auto-extracted search query' });
  });

  test('falls back to plain text when JSON has wrong shape (schema validation fails)', () => {
    const wrongShape = '{"needsSearch": "true"}';
    const result = parseSearchDecision(wrongShape);
    expect(result).toEqual({ needsSearch: false, isMultiSearch: false });
  });

  test('JSON path wins when both valid JSON and SEARCH: prefix could apply', () => {
    const text = 'SEARCH: {"needsSearch": false}';
    const result = parseSearchDecision(text);
    expect(result.needsSearch).toBe(false);
    expect(result.isMultiSearch).toBeFalsy();
  });

  test('trims whitespace around response', () => {
    expect(parseSearchDecision('  \n  NO_SEARCH  \n  ')).toEqual({
      needsSearch: false,
      isMultiSearch: false,
    });
    const searchResult = parseSearchDecision('  SEARCH: trimmed query  ');
    expect(searchResult.query).toBe('trimmed query');
  });
});
