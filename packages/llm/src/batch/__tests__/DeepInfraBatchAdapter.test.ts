import { describe, expect, it } from 'bun:test';
import { DeepInfraProvider } from '../../providers/DeepInfraProvider';
import { DeepInfraBatchAdapter } from '../DeepInfraBatchAdapter';

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';

interface Call {
  method: 'get' | 'post';
  path: string;
  body?: unknown;
}

function adapterWith(responses: Record<string, unknown>): { adapter: DeepInfraBatchAdapter; calls: Call[] } {
  const provider = new DeepInfraProvider({ apiKey: 'k' });
  const adapter = new DeepInfraBatchAdapter(provider, 'k');
  const calls: Call[] = [];
  (adapter as unknown as { httpClient: object }).httpClient = {
    get: async (path: string) => {
      calls.push({ method: 'get', path });
      return responses[`GET ${path}`];
    },
    post: async (path: string, body?: unknown) => {
      calls.push({ method: 'post', path, body });
      return responses[`POST ${path}`];
    },
  };
  return { adapter, calls };
}

const batch = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'batch_1',
  status,
  model: MODEL,
  created_at: 1_763_000_000,
  request_counts: { total: 2, completed: 1, failed: 1 },
  ...extra,
});

describe('DeepInfraBatchAdapter', () => {
  it('uploads one JSONL line per request, each the body a live call would send', async () => {
    const { adapter, calls } = adapterWith({
      'POST /files': { id: 'file_in' },
      'POST /batches': batch('validating'),
    });
    const options = { systemPrompt: '整理记忆', reasoningEffort: 'none' as const, jsonMode: true };

    const job = await adapter.submitBatch([
      { customId: 'a', prompt: '测试用户甲说了什么', options },
      { customId: 'b', prompt: '测试用户乙说了什么', options },
    ]);

    const form = calls[0].body as FormData;
    expect(form.get('purpose')).toBe('batch');
    const lines = (await (form.get('file') as Blob).text()).split('\n').map((l) => JSON.parse(l));
    const expected = new DeepInfraProvider({ apiKey: 'k' }).buildChatCompletionBody('测试用户甲说了什么', {
      ...options,
      model: MODEL,
    });
    expect(lines[0]).toEqual({ custom_id: 'a', method: 'POST', url: '/v1/chat/completions', body: expected });
    expect(lines[1].custom_id).toBe('b');

    expect(calls[1].body).toEqual({ input_file_id: 'file_in', endpoint: '/v1/chat/completions', completion_window: '24h' });
    expect(job).toMatchObject({ id: 'batch_1', provider: 'deepinfra', status: 'pending', totalRequests: 2 });
  });

  it('refuses a request that asks for a different model than the batch', async () => {
    const { adapter } = adapterWith({});
    await expect(
      adapter.submitBatch([{ customId: 'a', prompt: 'x', options: { model: 'other/model' } }], MODEL),
    ).rejects.toThrow(/one model/);
  });

  it('reads results from both the output and the error file', async () => {
    const output = JSON.stringify({
      custom_id: 'a',
      response: {
        status_code: 200,
        body: {
          model: MODEL,
          choices: [{ finish_reason: 'stop', message: { content: '{"facts":[]}', reasoning_content: 'r' } }],
          usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, prompt_tokens_details: { cached_tokens: 40 } },
        },
      },
      error: null,
    });
    const errors = [
      JSON.stringify({ custom_id: 'b', response: null, error: { code: 'cancelled', message: 'batch cancelled' } }),
      JSON.stringify({ custom_id: 'c', response: { status_code: 400, body: { error: { message: 'bad' } } }, error: null }),
    ].join('\n');
    const { adapter } = adapterWith({
      'GET /batches/batch_1': batch('completed', { output_file_id: 'file_out', error_file_id: 'file_err' }),
      'GET /files/file_out/content': `${output}\n`,
      'GET /files/file_err/content': new TextEncoder().encode(errors).buffer,
    });

    const results = await adapter.getBatchResults('batch_1');

    expect(results[0]).toMatchObject({
      customId: 'a',
      status: 'succeeded',
      response: { text: '{"facts":[]}', resolvedModel: MODEL, resolvedProviderName: 'deepinfra' },
    });
    expect(results[0].response?.usage?.cachedPromptTokens).toBe(40);
    expect(results[1]).toMatchObject({ customId: 'b', status: 'cancelled' });
    expect(results[2]).toMatchObject({ customId: 'c', status: 'errored', error: 'HTTP 400: bad' });
  });

  it('will not read results of a batch still running', async () => {
    const { adapter } = adapterWith({ 'GET /batches/batch_1': batch('in_progress') });
    await expect(adapter.getBatchResults('batch_1')).rejects.toThrow(/in_progress/);
  });
});
