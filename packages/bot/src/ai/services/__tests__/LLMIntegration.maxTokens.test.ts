/**
 * Verification for the "no artificial maxTokens cap" change: every provider must omit the field
 * when unconfigured and still return non-empty text. Specifically exercises Gemini (the provider
 * whose thinking-budget exhaustion under a low cap produced "Invalid response structure").
 *
 * Run: NETWORK_TESTS=1 bun test src/ai/services/LLMIntegration.maxTokens.test.ts
 */
import 'reflect-metadata';

import { describe, expect, test } from 'bun:test';
import { container } from 'tsyringe';
import { LLMService } from '@/ai/services/LLMService';
import { DITokens } from '@/core/DITokens';
import { ResourceCleanupService } from '@/services/video';
import {
  createAIManagerWithProvider,
  getIntegrationProvider,
  INTEGRATION_TEST_TIMEOUT_MS,
  type IntegrationProviderName,
} from './integrationTestHelpers';

// GeminiProvider's constructor resolves this DI token (for temp-file cleanup); the shared
// integration harness never registers it, which is why gemini/openai/anthropic are excluded
// there. Register it before any provider is built so Gemini can be constructed here.
if (!container.isRegistered(DITokens.RESOURCE_CLEANUP_SERVICE)) {
  container.registerInstance(DITokens.RESOURCE_CLEANUP_SERVICE, new ResourceCleanupService());
}

const LOG_PREFIX = '[LLMMaxTokensVerify]';
const LONG_TEST_TIMEOUT_MS = 90_000;

// A prompt that genuinely wants a multi-part answer — exactly where a low/exhausted token budget
// (thinking model under the old 2000 cap) produced empty content / "Invalid response structure".
const LONG_PROMPT =
  '请用中文分三段解释什么是数据库索引：第一段讲 B-Tree 与 Hash 索引的区别，' +
  '第二段讲聚簇与非聚簇索引，第三段讲一个常见的索引使用误区。每段两三句即可。';

function runProvider(name: IntegrationProviderName): void {
  describe.skipIf(!getIntegrationProvider(name))(`${name}: no-maxTokens omit path (real API)`, () => {
    const llm = new LLMService(createAIManagerWithProvider(name));

    test(
      'generate() with NO maxTokens returns non-empty text',
      async () => {
        const res = await llm.generate('用一句话自我介绍。', undefined, name);
        console.log(LOG_PREFIX, `[${name}] short`, {
          len: res.text?.length,
          preview: res.text?.slice(0, 60),
          usage: res.usage,
        });
        expect(typeof res.text).toBe('string');
        expect(res.text.trim().length).toBeGreaterThan(0);
      },
      INTEGRATION_TEST_TIMEOUT_MS,
    );

    test(
      'long-output prompt with NO maxTokens is not truncated to empty / errored',
      async () => {
        const res = await llm.generate(LONG_PROMPT, undefined, name);
        console.log(LOG_PREFIX, `[${name}] long`, {
          len: res.text?.length,
          completionTokens: res.usage?.completionTokens,
          tail: res.text?.slice(-50),
        });
        expect(typeof res.text).toBe('string');
        // A real multi-paragraph answer; the old empty/truncated failure produced ~0 chars.
        expect(res.text.trim().length).toBeGreaterThan(200);
      },
      LONG_TEST_TIMEOUT_MS,
    );
  });
}

for (const name of ['gemini', 'doubao', 'deepseek'] as IntegrationProviderName[]) {
  runProvider(name);
}
