// Mind Prompt Plugin — injects the mind subsystem's state-derived mood
// fragment into the reply pipeline's system prompt.
//
// Does nothing when mind is disabled, when the patch is empty, or when
// the mind service hasn't been registered (e.g. tests / minimal
// bootstraps). The plugin is pure wiring: all translation logic lives
// in `MindService.getPromptPatchFragment()` and further upstream in
// `mind/prompt/PromptPatchAssembler.ts`.

import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import type { MindService } from '@/mind';
import { logger } from '@/utils/logger';
import { Hook, RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

@RegisterPlugin({
  name: 'mind-prompt',
  version: '1.0.0',
  description: 'Injects mind-state mood fragment into the reply pipeline system prompt',
})
export class MindPromptPlugin extends PluginBase {
  private mind: MindService | null = null;

  async onInit(): Promise<void> {
    const container = getContainer();
    if (container.isRegistered(DITokens.MIND_SERVICE)) {
      this.mind = container.resolve<MindService>(DITokens.MIND_SERVICE);
    }
  }

  /**
   * PREPROCESS hook: ask the mind for the current mood fragment and push
   * it into `systemPromptFragments` so `PromptAssemblyStage` picks it up.
   *
   * Skipped silently in the following cases — none of them are errors:
   *   - plugin disabled
   *   - mind service not registered (avatar-only deployment)
   *   - mind.enabled=false (config opt-out)
   *   - mind.promptPatch.enabled=false (A/B opt-out)
   *   - phenotype unremarkable (empty fragment)
   */
  @Hook({ stage: 'onMessagePreprocess', priority: 'NORMAL', order: 10 })
  async onMessagePreprocess(context: HookContext): Promise<boolean> {
    if (!this.enabled || !this.mind) return true;
    if (!this.mind.isEnabled()) return true;
    try {
      const fragment = this.mind.getPromptPatchFragment();
      if (!fragment) return true;
      const existing = context.metadata.get('systemPromptFragments') ?? [];
      context.metadata.set('systemPromptFragments', [...existing, fragment]);
      logger.debug(`[MindPromptPlugin] injected mood fragment | len=${fragment.length}`);
    } catch (err) {
      logger.warn('[MindPromptPlugin] fragment assembly failed (non-fatal):', err);
    }
    return true;
  }
}
