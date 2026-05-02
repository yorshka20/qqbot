import type {
  PromptInjectionContext,
  PromptInjectionProducer,
} from '@/conversation/promptInjection/types';
import type { PromptManager } from '../PromptManager';

/**
 * Baseline producer — emits the rendered base.system template at the
 * cache-friendly front of system message #1. Single producer for the
 * entire base.system content (intentionally NOT split into identity /
 * safety / behavior etc. — keeps the prompt cache stable).
 *
 * Reads `whitelistGroupCapabilities` from `hookContext.metadata` to
 * decide whether to inject `llm.whitelist_limited.system` as
 * `whitelistLimitedFragment` variable.
 */
export function createBaselineProducer(deps: { promptManager: PromptManager }): PromptInjectionProducer {
  const { promptManager } = deps;
  return {
    name: 'baseline',
    layer: 'baseline',
    priority: 0, // base.system goes first within the baseline layer (persona-stable at priority 10 follows)
    produce(ctx: PromptInjectionContext) {
      const groupCaps = ctx.hookContext.metadata.get('whitelistGroupCapabilities');
      const whitelistLimitedFragment =
        Array.isArray(groupCaps) && groupCaps.length > 0
          ? (promptManager.render('llm.whitelist_limited.system') ?? '').trim()
          : '';
      const fragment = promptManager.renderBasePrompt({ whitelistLimitedFragment }) ?? '';
      if (!fragment) return null;
      return { producerName: 'baseline', priority: 0, fragment };
    },
  };
}
