// End to end through each cheap batch host (Sail, DeepInfra): submit, run, read results back.
// A batch can sit in the queue for a while, so this needs its own switch on top of NETWORK_TESTS.
//
// Run: NETWORK_TESTS=1 BATCH_TESTS=1 bun test packages/bot/src/ai/__tests__/Batch.network.test.ts

import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import { BatchService, CHEAPEST_BATCH_PROVIDERS } from '@qqbot/llm';
import {
  createAIManagerWithProvider,
  getIntegrationProvider,
  type IntegrationProviderName,
} from '../services/__tests__/integrationTestHelpers';

const BATCH_TIMEOUT_MS = 30 * 60_000;

const SYSTEM = '从对话中提取关于用户的长期事实，输出 JSON：{"facts": ["..."]}。没有就输出 {"facts": []}。';
const CHATS = {
  a: '测试用户甲：我下个月搬去杭州了，以后周末可以一起爬山。',
  b: '测试用户乙：今天中午吃什么？',
  c: '测试用户丙：我对花生过敏，聚餐别点带花生的菜。',
};

for (const host of CHEAPEST_BATCH_PROVIDERS) {
  const enabled = process.env.BATCH_TESTS === '1' && getIntegrationProvider(host as IntegrationProviderName) !== null;

  describe.skipIf(!enabled)(`${host} batch (real API)`, () => {
    test(
      'runs a small extraction batch and returns one parsed result per request',
      async () => {
        const service = new BatchService(createAIManagerWithProvider(host as IntegrationProviderName));
        const started = Date.now();
        const { job, results } = await service.submitAndWait(
          host,
          Object.entries(CHATS).map(([customId, prompt]) => ({
            customId,
            prompt,
            options: { systemPrompt: SYSTEM, jsonMode: true, reasoningEffort: 'none' },
          })),
          {
            pollIntervalMs: 10_000,
            timeoutMs: BATCH_TIMEOUT_MS,
            onProgress: (j) => console.log(`[${host} batch] ${j.status} ${j.succeededRequests}/${j.totalRequests}`),
          },
        );
        console.log(`[${host} batch] ${job.id} ${job.status} after ${((Date.now() - started) / 1000).toFixed(0)}s`);
        for (const r of results) {
          console.log(`[${host} batch] ${r.customId} ${r.status}: ${r.response?.text ?? r.error}`, r.response?.usage);
        }

        expect(job.status).toBe('succeeded');
        expect(results.map((r) => r.customId).sort()).toEqual(['a', 'b', 'c']);
        for (const r of results) {
          expect(r.status).toBe('succeeded');
          expect(JSON.parse(r.response?.text ?? '')).toHaveProperty('facts');
        }
      },
      BATCH_TIMEOUT_MS + 60_000,
    );
  });
}
