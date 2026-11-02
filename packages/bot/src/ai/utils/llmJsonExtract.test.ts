/**
 * Unit tests for LLM JSON extraction (extractJsonFromLlmText, parseLlmJson).
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  extractExpectedJsonFromLlmText,
  extractJsonFromLlmText,
  parseLlmJson,
} from './llmJsonExtract';

// ---------------------------------------------------------------------------
// Additional tests for expect option + jsonrepair (appended at end of file)
// ---------------------------------------------------------------------------

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

  test('returns null when no valid JSON', () => {
    expect(extractJsonFromLlmText('hello world')).toBeNull();
  });

  test('extracts valid JSON array', () => {
    const result = extractJsonFromLlmText('["array only"]');
    expect(result).not.toBeNull();
    if (result != null) {
      expect(JSON.parse(result)).toEqual(['array only']);
    }
  });

  test('extractExpectedJsonFromLlmText extracts card-deck array from wrapped text', () => {
    const wrapped = 'Here is the card:\n[{"type":"qa","question":"Q","answer":"A"}]';
    const result = extractExpectedJsonFromLlmText(wrapped);
    expect(result).not.toBeNull();
    if (result != null) {
      const parsed = JSON.parse(result);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual({ type: 'qa', question: 'Q', answer: 'A' });
    }
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

// ---------------------------------------------------------------------------
// expect option tests
// ---------------------------------------------------------------------------

describe('extractExpectedJsonFromLlmText – expect option', () => {
  // expect:'array' + array with unescaped inner quotes → jsonrepair fixes → returns array
  test("expect:'array' + array with unescaped inner quotes → repaired and returned", () => {
    // This simulates the original bug: LLM writes a string value with unquoted Chinese guillemets
    const malformed = `[{"type":"paragraph","content":"调用一句"鱼和熊掌不可兼得"就结束思考"}]`;
    const result = extractExpectedJsonFromLlmText(malformed, { expect: 'array' });
    // jsonrepair should fix the unescaped quotes; result must be non-null and an array
    expect(result).not.toBeNull();
    if (result != null) {
      const parsed = JSON.parse(result);
      expect(Array.isArray(parsed)).toBe(true);
    }
  });

  // expect:'array' + completely invalid array (unfixable) → null, never falls back to object
  test("expect:'array' + invalid array that cannot be repaired → null (no fallback to object)", () => {
    // A lone object with no array wrapper — braceMatch in array mode should NOT pick this up
    const objectOnly = '{"type":"paragraph","content":"hello world"}';
    const result = extractExpectedJsonFromLlmText(objectOnly, { expect: 'array' });
    expect(result).toBeNull();
  });

  // expect:'array' + valid array → returned normally
  test("expect:'array' + valid array → returned", () => {
    const text = '[{"type":"qa","question":"Q","answer":"A"}]';
    const result = extractExpectedJsonFromLlmText(text, { expect: 'array' });
    expect(result).not.toBeNull();
    if (result != null) {
      expect(Array.isArray(JSON.parse(result))).toBe(true);
    }
  });

  // expect:'object' + valid object → returned
  test("expect:'object' + valid object → returned", () => {
    const text = '{"key": "value"}';
    const result = extractExpectedJsonFromLlmText(text, { expect: 'object' });
    expect(result).not.toBeNull();
    if (result != null) {
      expect(typeof JSON.parse(result)).toBe('object');
      expect(Array.isArray(JSON.parse(result))).toBe(false);
    }
  });

  // expect:'any' (default) + array fails → falls back to object (backward compat)
  test("expect:'any' (default) + text with only object → returns object (backward compat)", () => {
    const text = 'Some prose. {"key":"value"}';
    const result = extractExpectedJsonFromLlmText(text);
    expect(result).not.toBeNull();
    if (result != null) {
      expect(Array.isArray(JSON.parse(result))).toBe(false);
    }
  });

  // jsonrepair: trailing comma
  test('jsonrepair fixes trailing comma in array', () => {
    const text = '[{"type":"list","items":["a","b",]}]';
    const result = extractExpectedJsonFromLlmText(text, { expect: 'array' });
    expect(result).not.toBeNull();
    if (result != null) {
      expect(Array.isArray(JSON.parse(result))).toBe(true);
    }
  });
});
