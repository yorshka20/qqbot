import { ProviderRouter } from '@/ai/routing/ProviderRouter';
import type { PromptInjectionContext, PromptInjectionProducer } from '@/conversation/promptInjection/types';
import { getSourceConfig } from '@/conversation/sources/registry';
import { logger } from '@/utils/logger';
import type { PromptManager } from '../PromptManager';

/**
 * Scene producer — emits the per-source scene template (e.g.
 * `scenes.qq-group.zh.scene`). Bot identity variables ({{botSelfId}},
 * {{botNicknameSuffix}}, {{botWakeWordAlias}}, {{botWakeWordTrigger}},
 * {{botProviderNicknames}}) live in the scene layer now: a bot's QQ number
 * and summoning mechanic are platform-specific, so they belong to the QQ
 * scenes rather than the platform-neutral base.system. Tool instruct
 * content is provided separately by ToolInstructProducer in the 'tool'
 * layer.
 *
 * Falls back to `llm.reply.system` if the per-source template is
 * missing (matches the legacy PromptAssemblyStage fallback).
 */
export function createSceneProducer(deps: {
  promptManager: PromptManager;
  /** Wake words that summon the bot without an @ (messageTrigger.wakeWords). */
  wakeWords: string[];
}): PromptInjectionProducer {
  const { promptManager, wakeWords } = deps;
  const nicknames = Object.entries(ProviderRouter.getNicknameAliasMap());
  const defaultNicknames = nicknames.filter(([, provider]) => provider === null).map(([nickname]) => nickname);
  const wakeWordList = [...new Set([...wakeWords, ...defaultNicknames])].map((w) => `「${w}」`).join('、');
  const providerNicknameList = nicknames
    .flatMap(([nickname, provider]) => (provider === null ? [] : [{ nickname, provider }]))
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map(({ nickname, provider }) => `「${nickname}」→${provider}`)
    .join('、');
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
        botWakeWordAlias: wakeWordList ? `，群友也常用唤醒词${wakeWordList}称呼你` : '',
        botWakeWordTrigger: wakeWordList ? `、或出现唤醒词${wakeWordList}` : '',
        botProviderNicknames: providerNicknameList,
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
