// Sail and DeepInfra serve DeepSeek models behind their own /chat/completions: the model's
// contract (reasoning_content replay, DSML, effort levels) is shared with DeepSeekProvider,
// while each host's request fields and usage shape are its own.

import { describe, expect, it } from 'bun:test';
import type { ToolDefinition } from '../../types';
import type { DeepSeekChatProvider } from '../DeepSeekChatProvider';
import { DeepInfraProvider } from '../DeepInfraProvider';
import { DeepSeekProvider } from '../DeepSeekProvider';
import { SailProvider } from '../SailProvider';

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const SAMPLING = { topP: 0.9, stop: ['\n\n'], frequencyPenalty: 0.1, presencePenalty: 0.2, maxTokens: 512 };

function capture(provider: DeepSeekChatProvider, usage: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  (provider as unknown as { httpClient: object }).httpClient = {
    post: async (_path: string, body: Record<string, unknown>) => {
      bodies.push(body);
      return {
        choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
        usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102, ...usage },
        model: MODEL,
      };
    },
  };
  return bodies;
}

describe('SailProvider wire', () => {
  it('caps output with max_completion_tokens and sends no field Sail rejects', async () => {
    const provider = new SailProvider({ apiKey: 'k' });
    const bodies = capture(provider);
    await provider.generate('hi', { ...SAMPLING, reasoningEffort: 'medium' });

    expect(bodies[0]).toMatchObject({ model: MODEL, max_completion_tokens: 512, top_p: 0.9, reasoning_effort: 'high' });
    for (const field of ['max_tokens', 'stop', 'frequency_penalty', 'presence_penalty']) {
      expect(bodies[0]).not.toHaveProperty(field);
    }
  });

  it('reports cache hits from prompt_tokens_details', async () => {
    const provider = new SailProvider({ apiKey: 'k' });
    capture(provider, { prompt_tokens_details: { cached_tokens: 80 } });
    const response = await provider.generate('hi');
    expect(response.usage?.cachedPromptTokens).toBe(80);
    expect(response.resolvedModel).toBe(MODEL);
  });
});

describe('DeepInfraProvider wire', () => {
  it('sends the OpenAI sampling fields under their usual names', async () => {
    const provider = new DeepInfraProvider({ apiKey: 'k' });
    const bodies = capture(provider);
    await provider.generate('hi', { ...SAMPLING, reasoningEffort: 'minimal' });

    expect(bodies[0]).toMatchObject({
      model: MODEL,
      max_tokens: 512,
      top_p: 0.9,
      stop: ['\n\n'],
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      reasoning_effort: 'low',
    });
  });

  it('reports cache hits from prompt_tokens_details', async () => {
    const provider = new DeepInfraProvider({ apiKey: 'k' });
    capture(provider, { prompt_tokens_details: { cached_tokens: 64 } });
    expect((await provider.generate('hi')).usage?.cachedPromptTokens).toBe(64);
  });
});

describe('tool-call provenance is per host', () => {
  const messages = [
    { role: 'user' as const, content: '甲是谁？' },
    {
      role: 'assistant' as const,
      content: '',
      provider: 'deepseek',
      reasoning_content: 'look it up',
      tool_calls: [{ id: 'd1', name: 'search', arguments: '{}' }],
    },
    { role: 'tool' as const, tool_call_id: 'd1', content: '甲是测试用户' },
  ];
  const tools: ToolDefinition[] = [{ name: 'search', description: 'search', parameters: { type: 'object', properties: {} } }];

  it("replays deepseek's own tool round verbatim on deepseek", async () => {
    const provider = new DeepSeekProvider({ apiKey: 'k' });
    const bodies = capture(provider);
    await provider.generate('', { tools, messages });
    expect((bodies[0].messages as Array<Record<string, unknown>>)[1].tool_calls).toBeDefined();
  });

  it('folds a round another provider served, even one running the same model', async () => {
    const provider = new SailProvider({ apiKey: 'k' });
    const bodies = capture(provider);
    await provider.generate('', { tools, messages });
    const sent = bodies[0].messages as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(2);
    expect(sent[1].tool_calls).toBeUndefined();
    expect(sent[1].reasoning_content).toBe('look it up');
  });
});
