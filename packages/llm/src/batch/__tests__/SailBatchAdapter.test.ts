import { describe, expect, it } from 'bun:test';
import { AIManager } from '../../AIManager';
import { DeepInfraProvider } from '../../providers/DeepInfraProvider';
import { SailProvider } from '../../providers/SailProvider';
import { BatchService } from '../BatchService';
import { SailBatchAdapter } from '../SailBatchAdapter';

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';

function adapterWith(responses: Record<string, unknown>): { adapter: SailBatchAdapter; posts: unknown[] } {
  const adapter = new SailBatchAdapter(new SailProvider({ apiKey: 'k' }), 'k');
  const posts: unknown[] = [];
  (adapter as unknown as { httpClient: object }).httpClient = {
    get: async (path: string) => responses[`GET ${path}`],
    post: async (path: string, body: unknown) => {
      posts.push(body);
      return responses[`POST ${path}`];
    },
  };
  return { adapter, posts };
}

const responseBody = (output: unknown[], status = 'completed') => ({
  status,
  model: MODEL,
  output,
  usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 41 }, output_tokens: 25, total_tokens: 75 },
});

describe('SailProvider Responses body', () => {
  const provider = new SailProvider({ apiKey: 'k' });

  it('puts the system prompt in instructions and maps effort, budget and JSON mode', () => {
    const body = provider.buildResponsesBody('测试用户甲说了什么', {
      systemPrompt: '整理记忆',
      reasoningEffort: 'medium',
      maxTokens: 800,
      jsonMode: true,
    });
    expect(body).toMatchObject({
      model: MODEL,
      instructions: '整理记忆',
      input: '测试用户甲说了什么',
      max_output_tokens: 800,
      reasoning: { effort: 'high' },
      text: { format: { type: 'json_schema', schema: { type: 'object' } } },
    });
  });

  it('refuses history and tools instead of dropping them', () => {
    expect(() => provider.buildResponsesBody('', { messages: [{ role: 'user', content: 'x' }] })).toThrow(/single prompt/);
  });

  it('reads reasoning and text from their output items', () => {
    const response = provider.parseResponsesBody(
      responseBody([
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: '17*23=391' }] },
        { type: 'message', content: [{ type: 'output_text', text: '391' }] },
      ]) as never,
      MODEL,
    );
    expect(response).toMatchObject({ text: '391', reasoningContent: '17*23=391', resolvedModel: MODEL });
    expect(response.usage?.cachedPromptTokens).toBe(41);
  });

  it('throws when an incomplete response carries no text', () => {
    expect(() =>
      provider.parseResponsesBody(
        { ...responseBody([], 'incomplete'), incomplete_details: { reason: 'max_output_tokens' } } as never,
        MODEL,
      ),
    ).toThrow(/status=incomplete, reason=max_output_tokens/);
  });
});

describe('SailBatchAdapter', () => {
  it('submits inline Responses requests built by the provider', async () => {
    const { adapter, posts } = adapterWith({ 'POST /batches': { id: 'batch_1', created_at: 1_763_000_000 } });
    const options = { systemPrompt: '整理记忆', reasoningEffort: 'none' as const };
    const job = await adapter.submitBatch([{ customId: 'a', prompt: '测试用户甲', options }]);

    expect(posts[0]).toEqual({
      endpoint: '/v1/responses',
      requests: [
        {
          custom_id: 'a',
          params: new SailProvider({ apiKey: 'k' }).buildResponsesBody('测试用户甲', { ...options, model: MODEL }),
        },
      ],
    });
    expect(job).toMatchObject({ id: 'batch_1', provider: 'sail', status: 'processing', totalRequests: 1 });
  });

  it('rejects a custom_id Sail would refuse', async () => {
    const { adapter } = adapterWith({});
    await expect(adapter.submitBatch([{ customId: 'Memory:1', prompt: 'x' }])).rejects.toThrow(/custom_id/);
  });

  it('maps inline results, failures and cancellations', async () => {
    const { adapter } = adapterWith({
      'GET /batches/batch_1': {
        id: 'batch_1',
        status: 'completed',
        created_at: 1_763_000_000,
        request_counts: { total: 3, completed: 1, failed: 2 },
        request_status: { a: { status: 'COMPLETED' }, b: { status: 'FAILED' }, c: { status: 'CANCELLED' } },
        results: [
          {
            custom_id: 'a',
            response: { status_code: 200, body: responseBody([{ type: 'message', content: [{ type: 'output_text', text: '{"facts":[]}' }] }]) },
            error: null,
          },
          { custom_id: 'b', response: null, error: { code: 'server_error', message: 'task failed during processing' } },
          { custom_id: 'c', response: null, error: { code: 'cancelled' } },
        ],
      },
    });

    const results = await adapter.getBatchResults('batch_1');
    expect(results[0]).toMatchObject({ customId: 'a', status: 'succeeded', response: { text: '{"facts":[]}' } });
    expect(results[1]).toMatchObject({ customId: 'b', status: 'errored', error: 'task failed during processing' });
    expect(results[2]).toMatchObject({ customId: 'c', status: 'cancelled' });
  });

  it('fetches results one by one when they are too large to inline', async () => {
    const item = (id: string) => ({
      custom_id: id,
      response: { status_code: 200, body: responseBody([{ type: 'message', content: [{ type: 'output_text', text: id }] }]) },
      error: null,
    });
    const { adapter } = adapterWith({
      'GET /batches/batch_1': {
        id: 'batch_1',
        status: 'completed',
        created_at: 1_763_000_000,
        request_counts: { total: 2, completed: 2, failed: 0 },
        request_status: { a: { status: 'COMPLETED' }, b: { status: 'COMPLETED' } },
        results: null,
        error: { code: 'batch_results_too_large' },
      },
      'GET /batches/batch_1/a': item('a'),
      'GET /batches/batch_1/b': item('b'),
    });
    expect((await adapter.getBatchResults('batch_1')).map((r) => r.response?.text)).toEqual(['a', 'b']);
  });
});

describe('BatchService.cheapestProvider', () => {
  it('prefers Sail, then DeepInfra, among the configured hosts', () => {
    const manager = new AIManager();
    manager.registerProvider(new DeepInfraProvider({ apiKey: 'k' }));
    const service = new BatchService(manager);
    expect(service.cheapestProvider()).toBe('deepinfra');
    manager.registerProvider(new SailProvider({ apiKey: 'k' }));
    expect(service.cheapestProvider()).toBe('sail');
  });

  it('is null when neither host is configured', () => {
    expect(new BatchService(new AIManager()).cheapestProvider()).toBeNull();
  });
});
