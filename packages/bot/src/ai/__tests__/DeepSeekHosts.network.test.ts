// The same DeepSeek V4.1 model through DeepSeek's own API, Sail and DeepInfra: what each host
// accepts on the wire (reasoning levels, reasoning_content replay with tools, images) and how
// fast it streams. The timing table is printed, not asserted — it is the comparison itself.
//
// Run: NETWORK_TESTS=1 bun test packages/bot/src/ai/__tests__/DeepSeekHosts.network.test.ts

import 'reflect-metadata';
import { afterAll, describe, expect, test } from 'bun:test';
import type { DeepSeekChatProvider } from '@qqbot/llm';
import {
  getIntegrationProvider,
  INTEGRATION_TOOL_USE_TIMEOUT_MS,
  type IntegrationProviderName,
  SAMPLE_TOOLS,
} from '../services/__tests__/integrationTestHelpers';

const HOSTS: IntegrationProviderName[] = ['deepseek', 'sail', 'deepinfra'];
const STREAM_RUNS = 3;
const STREAM_PROMPT = '用大约四百字介绍一下长江的地理特点，分三段写。';
const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

interface StreamSample {
  ttftMs: number;
  totalMs: number;
  completionTokens: number;
}

const report: Record<string, Record<string, string>> = {};
const note = (host: string, key: string, value: string) => {
  report[host] ??= {};
  report[host][key] = value;
};
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function streamOnce(provider: DeepSeekChatProvider): Promise<StreamSample> {
  const start = performance.now();
  let first = 0;
  const response = await provider.generateStream(
    STREAM_PROMPT,
    () => {
      first ||= performance.now();
    },
    { reasoningEffort: 'none', maxTokens: 1500 },
  );
  return {
    ttftMs: first - start,
    totalMs: performance.now() - start,
    completionTokens: response.usage?.completionTokens ?? 0,
  };
}

afterAll(() => {
  if (Object.keys(report).length) {
    console.log(`\n[DeepSeekHosts] ${new Date().toISOString()}`);
    console.table(report);
  }
});

for (const host of HOSTS) {
  const provider = getIntegrationProvider(host) as DeepSeekChatProvider | null;

  describe.skipIf(!provider)(`${host} (real API)`, () => {
    const p = provider as DeepSeekChatProvider;

    test(
      'streams; median time to first token and output speed',
      async () => {
        const samples: StreamSample[] = [];
        for (let i = 0; i < STREAM_RUNS; i++) {
          samples.push(await streamOnce(p));
        }
        expect(samples.every((s) => s.completionTokens > 0)).toBe(true);
        const ttft = median(samples.map((s) => s.ttftMs));
        const tps = median(samples.map((s) => s.completionTokens / ((s.totalMs - s.ttftMs) / 1000)));
        note(host, 'model', p.getDefaultModel());
        note(host, 'TTFT ms (median)', ttft.toFixed(0));
        note(host, 'output tok/s (median)', tps.toFixed(1));
        note(host, 'total ms (median)', median(samples.map((s) => s.totalMs)).toFixed(0));
      },
      INTEGRATION_TOOL_USE_TIMEOUT_MS * STREAM_RUNS,
    );

    test(
      'takes every reasoning level the pipeline sends',
      async () => {
        const tokens: string[] = [];
        for (const effort of ['none', 'minimal', 'low', 'medium', 'high'] as const) {
          const response = await p.generate('17 × 23 等于多少？只回答数字。', { reasoningEffort: effort });
          expect(response.text).toContain('391');
          tokens.push(`${effort}:${response.usage?.completionTokens}`);
        }
        note(host, 'completion tokens by effort', tokens.join(' '));
      },
      INTEGRATION_TOOL_USE_TIMEOUT_MS * 3,
    );

    test(
      'calls a tool, then accepts its own reasoning replayed on the tool round',
      async () => {
        const first = await p.generate('北京现在天气怎么样？', { tools: SAMPLE_TOOLS, reasoningEffort: 'low' });
        const call = first.functionCalls?.[0];
        expect(call?.name).toBe('get_weather');

        const second = await p.generate('', {
          tools: SAMPLE_TOOLS,
          reasoningEffort: 'low',
          messages: [
            { role: 'user', content: '北京现在天气怎么样？' },
            {
              role: 'assistant',
              content: first.text,
              provider: host,
              reasoning_content: first.reasoningContent,
              tool_calls: [{ id: call?.toolCallId ?? 'call_1', name: 'get_weather', arguments: call?.arguments ?? '{}' }],
            },
            { role: 'tool', tool_call_id: call?.toolCallId ?? 'call_1', content: '{"city":"北京","weather":"晴","temp":12}' },
          ],
        });
        expect(second.text).toContain('晴');
        note(host, 'cached prompt tokens reported', String(second.usage?.cachedPromptTokens ?? '—'));
      },
      INTEGRATION_TOOL_USE_TIMEOUT_MS,
    );

    test(
      'image input (recorded, not asserted: decides the vision capability)',
      async () => {
        try {
          const response = await p.generateWithVision('这张图片是什么颜色？一个词回答。', [
            { base64: ONE_PIXEL_PNG, mimeType: 'image/png' },
          ]);
          note(host, 'vision', `ok: ${response.text.trim().slice(0, 20)}`);
        } catch (error) {
          note(host, 'vision', `rejected: ${error instanceof Error ? error.message.slice(0, 80) : String(error)}`);
        }
      },
      INTEGRATION_TOOL_USE_TIMEOUT_MS,
    );
  });
}
