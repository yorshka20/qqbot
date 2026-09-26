// A thinking model charges its hidden CoT against max_tokens, so the cap can be
// spent entirely on reasoning and the response arrives with finish_reason=length
// and no content. Returning that as an empty string makes a truncated generation
// indistinguishable from "nothing to say", which is how a memory-extract failure
// went silent.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { DeepSeekProviderConfig } from '@/core/config/types/ai';
import type { ToolDefinition } from '../../types';
import { DeepSeekProvider } from '../DeepSeekProvider';

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

/** Capture the request body the provider would post, answering with an empty stop. */
function providerCapturing(): { provider: DeepSeekProvider; bodies: Array<Record<string, unknown>> } {
  const provider = providerReturning({ finish_reason: 'stop', message: { content: '' } });
  const bodies: Array<Record<string, unknown>> = [];
  (provider as unknown as { httpClient: { post: (u: string, b: unknown) => Promise<unknown> } }).httpClient = {
    post: async (_url, body) => {
      bodies.push(body as Record<string, unknown>);
      return { choices: [{ finish_reason: 'stop', message: { content: '' } }], model: 'deepseek-v4-pro' };
    },
  };
  return { provider, bodies };
}

// With tools on, the thinking mode rejects any assistant message after the last user message
// that has no reasoning_content field — which is what a fallback from another provider
// mid tool loop used to send, as the folded recap of that provider's tool round.
describe('DeepSeekProvider reasoning_content on the wire', () => {
  const tool: ToolDefinition = { name: 'search', description: 'search', parameters: { type: 'object', properties: {} } };

  it('carries the foreign round reasoning onto the folded recap after a fallback', async () => {
    const { provider, bodies } = providerCapturing();
    await provider.generate('', {
      tools: [tool],
      messages: [
        { role: 'user', content: '甲是谁？' },
        {
          role: 'assistant',
          content: '',
          provider: 'gemini',
          reasoning_content: 'I should look this up.',
          tool_calls: [{ id: 'g1', name: 'search', arguments: '{"q":"甲"}' }],
        },
        { role: 'tool', tool_call_id: 'g1', content: '甲是测试用户' },
      ],
    });

    const sent = bodies[0].messages as Array<Record<string, unknown>>;
    const recap = sent[sent.length - 1];
    expect(recap.role).toBe('assistant');
    expect(recap.tool_calls).toBeUndefined();
    expect(recap.content).toContain('我调用了 search');
    expect(recap.reasoning_content).toBe('I should look this up.');
  });

  it('sends an empty reasoning_content on assistant messages that have none', async () => {
    const { provider, bodies } = providerCapturing();
    await provider.generate('', {
      tools: [tool],
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好呀' },
        { role: 'user', content: '甲是谁？' },
        {
          role: 'assistant',
          content: '',
          provider: 'openai',
          tool_calls: [{ id: 'o1', name: 'search', arguments: '{}' }],
        },
        { role: 'tool', tool_call_id: 'o1', content: '甲是测试用户' },
      ],
    });

    const assistants = (bodies[0].messages as Array<Record<string, unknown>>).filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    for (const m of assistants) {
      expect(m.reasoning_content).toBe('');
    }
  });
});
