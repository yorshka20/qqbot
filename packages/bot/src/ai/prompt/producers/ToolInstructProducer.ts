import type { PromptInjectionContext, PromptInjectionProducer } from '@/conversation/promptInjection/types';
import type { PromptManager } from '../PromptManager';

/**
 * Tool-instruct producer — renders `llm.tool.instruct` with the
 * `toolUsageInstructions` value mirrored into hookContext.metadata by
 * ProviderSelectionStage. Returns null when there are no tool
 * instructions for the current request.
 */
export function createToolInstructProducer(deps: { promptManager: PromptManager }): PromptInjectionProducer {
  const { promptManager } = deps;
  return {
    name: 'tool-instruct',
    layer: 'tool',
    priority: 0,
    produce(ctx: PromptInjectionContext) {
      const raw = ctx.hookContext.metadata.get('toolUsageInstructions');
      const toolUsageInstructions = typeof raw === 'string' ? raw : '';
      if (!toolUsageInstructions) return null;
      const fragment = promptManager.render('llm.tool.instruct', { toolUsageInstructions }) ?? '';
      if (!fragment) return null;
      return { producerName: 'tool-instruct', priority: 0, fragment };
    },
  };
}
