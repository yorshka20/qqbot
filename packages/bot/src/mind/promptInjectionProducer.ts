/**
 * Phase 3.6: factory for the mind PromptInjectionProducer.
 *
 * Extracted into its own module so:
 *   1. MindInitializer can call it without runtime-importing the registry class.
 *   2. Unit tests can exercise the producer in isolation with a fake MindService.
 */

import type { MessageSource } from '@/conversation/sources';
import type { PromptInjectionProducer } from '@/conversation/promptInjection/types';
import type { MindConfig } from './types';

/** Minimal subset of MindService required by the producer. */
export interface MindServiceLike {
  isEnabled(): boolean;
  getPromptPatchFragmentAsync(opts?: { userId?: string }): Promise<string>;
}

const FALLBACK_SOURCES: readonly MessageSource[] = [
  'qq-private',
  'qq-group',
  'avatar-cmd',
  'bilibili-danmaku',
];

/**
 * Creates a PromptInjectionProducer that injects mind/persona state into the
 * system prompt for applicable message sources.
 */
export function createMindPromptInjectionProducer(deps: {
  mindService: MindServiceLike;
  config: MindConfig;
}): PromptInjectionProducer {
  const { mindService, config } = deps;
  return {
    name: 'mind',
    applicableSources: config.promptPatch.applicableSources ?? FALLBACK_SOURCES,
    priority: 10,
    async produce(ctx) {
      if (!mindService.isEnabled()) return null;
      if (!config.promptPatch.enabled) return null;
      const userId = ctx.userId;
      const fragment = await mindService.getPromptPatchFragmentAsync(userId ? { userId } : undefined);
      if (!fragment) return null;
      return { producerName: 'mind', priority: 10, fragment };
    },
  };
}
