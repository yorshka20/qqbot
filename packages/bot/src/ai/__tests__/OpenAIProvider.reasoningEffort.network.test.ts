// Checks OPENAI_MODEL_REASONING_EFFORTS against the live Responses API: every row must
// list exactly the efforts that model accepts, and a lite call (`reasoningEffort: 'none'`)
// must succeed on the configured model whatever that model's set is.
//
// Run: NETWORK_TESTS=1 bun test packages/bot/src/ai/__tests__/OpenAIProvider.reasoningEffort.network.test.ts

import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import OpenAI from 'openai';
import type { OpenAIProviderConfig } from '@qqbot/llm';
import {
  getIntegrationProvider,
  INTEGRATION_TEST_TIMEOUT_MS,
  loadConfigOnce,
} from '../services/__tests__/integrationTestHelpers';
import {
  OPENAI_MODEL_REASONING_EFFORTS,
  OPENAI_REASONING_EFFORTS_ASCENDING,
  type OpenAIProvider,
} from '@qqbot/llm';

const provider = getIntegrationProvider('openai') as OpenAIProvider | null;

function rawClient(): OpenAI {
  const config = loadConfigOnce()?.getAIConfig()?.providers?.openai as OpenAIProviderConfig;
  return new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
}

/** True when the model takes the effort; false only on a 400 whose `param` is the effort. */
async function acceptsEffort(client: OpenAI, model: string, effort: string): Promise<boolean> {
  try {
    await client.responses.create({
      model,
      input: 'Reply with OK.',
      max_output_tokens: 64,
      store: false,
      reasoning: { effort: effort as NonNullable<OpenAI.ReasoningEffort> },
    });
    return true;
  } catch (error) {
    if (error instanceof OpenAI.BadRequestError && error.param === 'reasoning.effort') {
      return false;
    }
    throw error;
  }
}

describe.skipIf(!provider)('OpenAI reasoning effort per model (real API)', () => {
  test.each(Object.keys(OPENAI_MODEL_REASONING_EFFORTS))(
    '%s accepts exactly its listed efforts',
    async (model) => {
      const client = rawClient();
      const accepted: string[] = [];
      for (const effort of OPENAI_REASONING_EFFORTS_ASCENDING) {
        if (await acceptsEffort(client, model, effort)) {
          accepted.push(effort);
        }
      }
      expect(accepted).toEqual([...OPENAI_MODEL_REASONING_EFFORTS[model]]);
    },
    INTEGRATION_TEST_TIMEOUT_MS * 4,
  );

  test(
    'a lite call with reasoningEffort none succeeds on the configured model',
    async () => {
      const response = await (provider as OpenAIProvider).generate('Reply with OK.', {
        reasoningEffort: 'none',
        maxTokens: 64,
      });
      expect(response.metadata?.finishReason).toBeDefined();
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});
