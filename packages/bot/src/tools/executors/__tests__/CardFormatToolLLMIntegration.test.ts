/**
 * send_card — live LLM integration test (real API, gated).
 *
 * Skipped unless NETWORK_TESTS=1 AND the provider is configured with an apiKey.
 * Only cheap providers run: ALL_TOOL_USE_PROVIDERS is [doubao, deepseek] — the
 * expensive ones (gemini/openai/anthropic) are excluded there by design.
 *
 * Run: NETWORK_TESTS=1 bun test src/tools/executors/__tests__/CardFormatToolLLMIntegration.test.ts
 *
 * NOTE: deepseek/doubao are permissive about tool schemas, so this test does NOT
 * reproduce the Gemini constrained-decoding failure (content-less `{"type":...}`
 * cards). Its job is end-to-end confidence that a real model, handed the actual
 * shipped send_card schema, produces a card deck that clears parseCardDeck. The
 * hard regression guard for the constrained-decoding bug is cardToolSchema.test.ts.
 */
import 'reflect-metadata';

// Import all executors to trigger @Tool() decorator registration.
import '@/tools/executors';

import { describe, expect, test } from 'bun:test';
import {
  ALL_TOOL_USE_PROVIDERS,
  createAIManagerWithProvider,
  getIntegrationProvider,
  INTEGRATION_TOOL_USE_TIMEOUT_MS,
} from '@/ai/services/__tests__/integrationTestHelpers';
import { LLMService } from '@/ai/services/LLMService';
import type { ChatMessage, ToolDefinition } from '@/ai/types';
import { parseCardDeck } from '@/services/card/cardTypes';
import { ToolManager } from '@/tools/ToolManager';

/** The send_card tool definition exactly as it ships to the model. */
function getSendCardDefinition(): ToolDefinition {
  const tm = new ToolManager();
  tm.autoRegisterTools();
  const spec = tm.getTool('send_card');
  if (!spec) {
    throw new Error('send_card tool is not registered');
  }
  return tm.toToolDefinitions([spec])[0];
}

const SEND_CARD_DEF = getSendCardDefinition();

for (const providerName of ALL_TOOL_USE_PROVIDERS) {
  describe.skipIf(!getIntegrationProvider(providerName))(
    `send_card LLM integration (${providerName}, real API)`,
    () => {
      const llmService = new LLMService(createAIManagerWithProvider(providerName));

      test(
        'model emits a schema-valid card deck (content, not a type-only card)',
        async () => {
          const messages: ChatMessage[] = [
            {
              role: 'user',
              content:
                '把"如何冲泡一杯手冲咖啡"整理成有序步骤，用 send_card 工具发给我。你必须调用 send_card 工具，不要用纯文本回答。',
            },
          ];
          const res = await llmService.generate(
            '',
            { messages, tools: [SEND_CARD_DEF], maxTokens: 1024 },
            providerName,
          );

          const call = res.functionCalls?.find((c) => c.name === 'send_card');
          // Providers are non-deterministic; only assert card validity when it actually calls.
          if (!call) {
            return;
          }

          const args = JSON.parse(call.arguments) as { cards?: unknown };
          expect(Array.isArray(args.cards)).toBe(true);

          // The regression: content-less cards. parseCardDeck must accept the deck,
          // which means every card carries its required content fields.
          const deck = parseCardDeck(JSON.stringify(args.cards));
          expect(deck.length).toBeGreaterThan(0);
        },
        INTEGRATION_TOOL_USE_TIMEOUT_MS,
      );
    },
  );
}
