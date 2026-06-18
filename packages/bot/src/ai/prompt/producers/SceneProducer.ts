import type { PromptInjectionContext, PromptInjectionProducer } from '@/conversation/promptInjection/types';
import { getSourceConfig } from '@/conversation/sources/registry';
import { logger } from '@/utils/logger';
import type { PromptManager } from '../PromptManager';

/**
 * Scene producer — emits the per-source scene template (e.g.
 * `scenes.qq-group.zh.scene`). Bot identity variables ({{botSelfId}},
 * {{botNicknameSuffix}}) live in the scene layer now: a bot's QQ number
 * and summoning mechanic are platform-specific, so they belong to the
 * QQ scenes rather than the platform-neutral base.system. Tool instruct
 * content is provided separately by ToolInstructProducer in the 'tool'
 * layer.
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
      const sceneVars: Record<string, string> = {
        botSelfId: promptManager.botSelfId || '（未配置）',
        botNicknameSuffix: promptManager.botNickname ? `，昵称「${promptManager.botNickname}」` : '',
      };
      let fragment: string;
      try {
        fragment = promptManager.render(sceneTemplateId, sceneVars) ?? '';
      } catch (err) {
        logger.warn(
          `[SceneProducer] scene template ${sceneTemplateId} render failed, falling back to llm.reply.system:`,
          err,
        );
        fragment = promptManager.render('llm.reply.system', sceneVars) ?? '';
      }
      if (!fragment) return null;
      return { producerName: 'scene', priority: 0, fragment };
    },
  };
}
