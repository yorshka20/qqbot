// How the pipeline's reasoning effort maps onto the Responses API `reasoning` param for a
// given model. The accepted set is per model, so the same effort can resolve differently
// depending on which model a request (or a fallback) lands on.

import { describe, expect, it } from 'bun:test';
import { mapReasoningEffortToOpenAI } from '../OpenAIProvider';

describe('mapReasoningEffortToOpenAI', () => {
  it('sends none as-is to a model that accepts it, without a summary', () => {
    expect(mapReasoningEffortToOpenAI('none', 'gpt-6.1-terra')).toEqual({ effort: 'none' });
  });

  it('rounds none up to low on a model that dropped none', () => {
    expect(mapReasoningEffortToOpenAI('none', 'gpt-6.1-sol')).toEqual({ effort: 'low', summary: 'auto' });
    expect(mapReasoningEffortToOpenAI('none', 'gpt-6-astra')).toEqual({ effort: 'low', summary: 'auto' });
  });

  it('rounds minimal up to low, which no current model lacks', () => {
    expect(mapReasoningEffortToOpenAI('minimal', 'gpt-5.6-terra')).toEqual({ effort: 'low', summary: 'auto' });
  });

  it('passes accepted efforts through unchanged', () => {
    expect(mapReasoningEffortToOpenAI('medium', 'gpt-6.1-sol')).toEqual({ effort: 'medium', summary: 'auto' });
    expect(mapReasoningEffortToOpenAI('high', 'gpt-6.1-sol')).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('resolves a dated snapshot id through its alias row', () => {
    expect(mapReasoningEffortToOpenAI('none', 'gpt-6.1-sol-2026-09-30')).toEqual({ effort: 'low', summary: 'auto' });
  });

  it('sends no reasoning param for a model missing from the table', () => {
    expect(mapReasoningEffortToOpenAI('none', 'gpt-4.1')).toBeUndefined();
  });

  it('sends no reasoning param when the caller gave no effort', () => {
    expect(mapReasoningEffortToOpenAI(undefined, 'gpt-6.1-sol')).toBeUndefined();
  });
});
