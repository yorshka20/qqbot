// DeepSeek clamps max_tokens to 8192, and a thinking model charges its hidden CoT
// against that same budget — so the cap can be spent entirely on reasoning and the
// response arrives with finish_reason=length and no content. Returning that as an
// empty string makes a truncated generation indistinguishable from "nothing to say",
// which is how a memory-extract failure went silent.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { DeepSeekProviderConfig } from '@/core/config/types/ai';
import { DeepSeekProvider } from './DeepSeekProvider';

interface Choice {
  finish_reason?: string;
  message: { content?: string; reasoning_content?: string };
}

/** Stub the HTTP layer so no network is hit; the provider sees one canned choice. */
function providerReturning(choice: Choice): DeepSeekProvider {
  const provider = new DeepSeekProvider({
    type: 'deepseek',
    apiKey: 'test-key',
    model: 'deepseek-v4-pro',
  } as DeepSeekProviderConfig);
  (provider as unknown as { httpClient: { post: () => Promise<unknown> } }).httpClient = {
    post: async () => ({
      choices: [choice],
      usage: { prompt_tokens: 15238, completion_tokens: 8192, total_tokens: 23430 },
      model: 'deepseek-v4-pro',
    }),
  };
  return provider;
}

describe('DeepSeekProvider truncation', () => {
  it('throws when the budget was spent on reasoning and no content came back', async () => {
    const provider = providerReturning({
      finish_reason: 'length',
      message: { reasoning_content: 'thought at length, never answered' },
    });

    await expect(provider.generate('extract memories')).rejects.toThrow(/finish_reason=length/);
  });

  it('passes an empty answer through when the model simply stopped', async () => {
    const provider = providerReturning({ finish_reason: 'stop', message: { content: '' } });

    const res = await provider.generate('extract memories');
    expect(res.text).toBe('');
  });

  it('keeps a truncated but non-empty answer rather than discarding it', async () => {
    const provider = providerReturning({ finish_reason: 'length', message: { content: '{"group_facts": [' } });

    const res = await provider.generate('extract memories');
    expect(res.text).toBe('{"group_facts": [');
  });
});
