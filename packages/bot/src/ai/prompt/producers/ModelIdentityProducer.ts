import type {
  PromptInjection,
  PromptInjectionContext,
  PromptInjectionProducer,
} from '@/conversation/promptInjection/types';

/**
 * Baseline producer — injects a one-line self-identification statement so the
 * LLM knows which model it is running as. Knowing one's own identity provides
 * a positive constraint: the model tends to behave more consistently with its
 * own capabilities and training when it is explicitly told who it is.
 *
 * The fragment is placed at priority 1 inside the baseline layer (after
 * base.system at priority 0, before persona-stable at priority 10) so it sits
 * close to the other runtime-environment facts (date, admin).
 *
 * Provider name and model are written to hookContext.metadata by
 * ProviderSelectionStage, which runs before PromptAssemblyStage. The cache
 * key is already per-provider, so injecting provider/model here does not
 * invalidate prefix-match caches.
 */
export function createModelIdentityProducer(): PromptInjectionProducer {
  return {
    name: 'model-identity',
    layer: 'baseline',
    priority: 1,
    produce(ctx: PromptInjectionContext): PromptInjection | null {
      const provider = ctx.hookContext.metadata.get('promptProviderName');
      const model = ctx.hookContext.metadata.get('promptModelName');
      if (!provider && !model) return null;
      let fragment: string;
      if (provider && model) {
        fragment = `你的底层语言模型为 ${model}（${provider} 提供）。`;
      } else if (model) {
        fragment = `你的底层语言模型为 ${model}。`;
      } else {
        fragment = `你由 ${provider} 的语言模型驱动。`;
      }
      return { producerName: 'model-identity', priority: 1, fragment };
    },
  };
}
