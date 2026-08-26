import type {
  PromptInjection,
  PromptInjectionContext,
  PromptInjectionProducer,
} from '@/conversation/promptInjection/types';
import type { PromptManager } from '../PromptManager';

/** Namespace holding one optional system patch per provider (`prompts/providers/<name>.system.txt`). */
const PROVIDER_PATCH_NAMESPACE = 'providers';
/**
 * Tail of the baseline layer — after persona (10) and persona-subtext (15).
 * A patch corrects vendor-specific behaviour that the persona blocks would
 * otherwise reinforce, so it has to be read last.
 */
const PRIORITY_PROVIDER_PATCH = 20;

/**
 * Provider-patch producer — injects `providers.<provider>.system` for the
 * provider resolved for this turn, when that template exists.
 *
 * Which providers carry a patch is decided by which files are present in the
 * prompts directory, not by code: compensating for one vendor's behavioural
 * quirks is prompt tuning, and must not require touching the pipeline.
 *
 * Provider name comes from `promptProviderName`, written by
 * ProviderSelectionStage (same source as ModelIdentityProducer).
 */
export function createProviderPatchProducer(deps: { promptManager: PromptManager }): PromptInjectionProducer {
  const { promptManager } = deps;
  return {
    name: 'provider-patch',
    layer: 'baseline',
    priority: PRIORITY_PROVIDER_PATCH,
    produce(ctx: PromptInjectionContext): PromptInjection | null {
      const provider = ctx.hookContext.metadata.get('promptProviderName');
      if (!provider) return null;
      const templateId = `${PROVIDER_PATCH_NAMESPACE}.${provider}.system`;
      if (!promptManager.getTemplate(templateId)) return null;
      const fragment = promptManager.render(templateId).trim();
      if (!fragment) return null;
      return { producerName: 'provider-patch', priority: PRIORITY_PROVIDER_PATCH, fragment };
    },
  };
}
