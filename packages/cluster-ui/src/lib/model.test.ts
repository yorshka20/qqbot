import { describe, expect, test } from 'bun:test';
import { modelDisplayName } from './model';

describe('modelDisplayName', () => {
  test('reads a claude id as family and version', () => {
    expect(modelDisplayName('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5');
    expect(modelDisplayName('claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(modelDisplayName('claude-haiku-5-5')).toBe('Claude Haiku 5.5');
    expect(modelDisplayName('claude-fable-5-1')).toBe('Claude Fable 5.1');
  });

  test('reads a gpt id as version and variant', () => {
    expect(modelDisplayName('gpt-5.6-sol')).toBe('GPT-5.6 Sol');
  });

  test('keeps an unknown id as it came, and names an absent one', () => {
    expect(modelDisplayName('gemini-3-pro')).toBe('gemini-3-pro');
    expect(modelDisplayName(undefined)).toBe('未知');
    expect(modelDisplayName('')).toBe('未知');
  });
});
