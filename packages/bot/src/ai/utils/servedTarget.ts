import type { AIGenerateResponse, ConcreteLLMTarget } from '@qqbot/llm';
import type { HookContext } from '@/hooks/types';

/**
 * The provider and model that served a response, or null when no model did (LLMService's canned
 * "no provider available" reply carries neither). LLMService stamps both on every response it returns.
 */
export function servedTargetOf(
  response: Pick<AIGenerateResponse, 'resolvedProviderName' | 'resolvedModel'>,
): ConcreteLLMTarget | null {
  const { resolvedProviderName: provider, resolvedModel: model } = response;
  return provider && model ? { provider, model } : null;
}

/**
 * An `onProviderResolved` callback that records the serving target on `context`, so a tool
 * running mid-loop (send_card) can attribute its output to the model that is actually answering.
 */
export function recordActiveTarget(context: HookContext): (target: ConcreteLLMTarget) => void {
  return (target) => {
    context.metadata.set('activeTarget', target);
  };
}
