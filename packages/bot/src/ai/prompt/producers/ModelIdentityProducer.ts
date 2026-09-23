import type {
  PromptInjection,
  PromptInjectionContext,
  PromptInjectionProducer,
} from '@/conversation/promptInjection/types';
import type { PromptManager } from '../PromptManager';

/** Template carrying the wording; the producer only supplies this turn's values. */
const TEMPLATE_ID = 'llm.model_identity';
/**
 * Head of the baseline layer — right after base.system (0), so the identity sits
 * with the other runtime-environment facts (date, admin) and ahead of persona.
 */
const PRIORITY_MODEL_IDENTITY = 1;

/**
 * Model-identity producer — renders `llm.model_identity` for the provider and
 * model resolved for this turn. Knowing one's own identity provides a positive
 * constraint: the model tends to behave more consistently with its own
 * capabilities and training when it is explicitly told who it is.
 *
 * The identity is per-turn, which the template has to say. Routing picks a
 * provider per turn (explicit prefix, vision handoff, health swap), so the
 * history a model reads contains assistant turns written by other models.
 *
 * Provider name and model are written to hookContext.metadata by
 * ProviderSelectionStage, which runs before PromptAssemblyStage. The cache
 * key is already per-provider, so injecting provider/model here does not
 * invalidate prefix-match caches.
 */
export function createModelIdentityProducer(deps: { promptManager: PromptManager }): PromptInjectionProducer {
  const { promptManager } = deps;
  return {
    name: 'model-identity',
    layer: 'baseline',
    priority: PRIORITY_MODEL_IDENTITY,
    produce(ctx: PromptInjectionContext): PromptInjection | null {
      // The stage always resolves a provider name, and only sometimes a model,
      // so provider absence means the stage never ran for this turn.
      const provider = ctx.hookContext.metadata.get('promptProviderName');
      if (!provider) return null;
      const fragment = promptManager.render(TEMPLATE_ID, {
        provider,
        model: ctx.hookContext.metadata.get('promptModelName') ?? '',
      });
      return fragment ? { producerName: 'model-identity', priority: PRIORITY_MODEL_IDENTITY, fragment } : null;
    },
  };
}
