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

const FALLBACK_SYNTHETIC_INCLUSIVE: readonly MessageSource[] = [
  'qq-private',
  'qq-group',
  'avatar-cmd',
  'bilibili-danmaku',
];

/**
 * Resolution order for the mind producer's `applicableSources`:
 *   1. `promptPatch.applicableSources` if set — fine-grained prompt-only override
 *   2. `mind.applicableSources` if set — master mind allow-list
 *      (extended with avatar-cmd / bilibili-danmaku to keep avatar-driven
 *      LLM paths personalised, since those don't appear in the master list
 *      which only governs real-IM stimulus / reflection)
 *   3. Hard-coded fallback (synthetic-inclusive default)
 */
function resolveProducerSources(config: MindConfig): readonly MessageSource[] {
  if (config.promptPatch.applicableSources && config.promptPatch.applicableSources.length > 0) {
    return config.promptPatch.applicableSources;
  }
  const master = config.applicableSources;
  if (master && master.length > 0) {
    const set = new Set<MessageSource>(master);
    set.add('avatar-cmd');
    set.add('bilibili-danmaku');
    return Array.from(set);
  }
  return FALLBACK_SYNTHETIC_INCLUSIVE;
}

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
    applicableSources: resolveProducerSources(config),
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
