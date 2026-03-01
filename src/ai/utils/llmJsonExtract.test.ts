/**
 * Unit tests for LLM JSON extraction (extractJsonFromLlmText, parseLlmJson).
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { extractJsonFromLlmText, parseLlmJson } from './llmJsonExtract';

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
});
