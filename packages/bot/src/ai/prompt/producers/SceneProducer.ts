import type { PromptInjectionContext, PromptInjectionProducer } from '@/conversation/promptInjection/types';
import { getSourceConfig } from '@/conversation/sources/registry';
import { logger } from '@/utils/logger';
import type { PromptManager } from '../PromptManager';

/**
 * Scene producer — emits the per-source scene template (e.g.
 * `scenes.qq-group.zh.scene`). The {{toolInstruct}} placeholder inside
 * scene templates is rendered as empty string here, because tool
 * instruct content is now provided separately by ToolInstructProducer
 * in the 'tool' layer.
 *
 * Falls back to `llm.reply.system` if the per-source template is
 * missing (matches the legacy PromptAssemblyStage fallback).
 */
export function createSceneProducer(deps: { promptManager: PromptManager }): PromptInjectionProducer {
  const { promptManager } = deps;
  return {
    name: 'scene',
    layer: 'scene',
    priority: 0,
    produce(ctx: PromptInjectionContext) {
      const sourceCfg = getSourceConfig(ctx.source);
      const sceneTemplateId = `scenes.${sourceCfg.promptScene}.zh.scene`;
      let fragment: string;
      try {
        fragment = promptManager.render(sceneTemplateId, { toolInstruct: '' }) ?? '';
      } catch (err) {
        logger.warn(
          `[SceneProducer] scene template ${sceneTemplateId} render failed, falling back to llm.reply.system:`,
          err,
        );
        fragment = promptManager.render('llm.reply.system', { toolInstruct: '' }) ?? '';
      }
      if (!fragment) return null;
      return { producerName: 'scene', priority: 0, fragment };
    },
  };
}
