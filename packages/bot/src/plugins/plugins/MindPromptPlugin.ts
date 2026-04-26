// Mind Prompt Plugin — injects the mind subsystem's state-derived mood
// fragment into the reply pipeline's system prompt, and updates the
// persona↔user relationship after each reply completes.
//
// Does nothing when mind is disabled, when the patch is empty, or when
// the mind service hasn't been registered (e.g. tests / minimal
// bootstraps). The plugin is pure wiring: all translation logic lives
// in `MindService.getPromptPatchFragmentAsync()` and further upstream in
// `mind/prompt/PromptPatchAssembler.ts`.

import { getReply } from '@/context/HookContextHelpers';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import type { MindService } from '@/mind';
import type { EpigeneticsStore } from '@/mind/epigenetics/EpigeneticsStore';
import { RelationshipUpdater } from '@/mind/relationships/RelationshipUpdater';
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
  private relationshipUpdater: RelationshipUpdater | null = null;

  async onInit(): Promise<void> {
    const container = getContainer();
    if (container.isRegistered(DITokens.MIND_SERVICE)) {
      this.mind = container.resolve<MindService>(DITokens.MIND_SERVICE);
    }
    if (this.mind && container.isRegistered(DITokens.EPIGENETICS_STORE)) {
      const store = container.resolve<EpigeneticsStore>(DITokens.EPIGENETICS_STORE);
      this.mind.setEpigeneticsStore(store);
      this.relationshipUpdater = new RelationshipUpdater(store);
    }
  }

  /**
   * PREPROCESS hook: ask the mind for the current mood + relationship fragment
   * and push it into `systemPromptFragments` so `PromptAssemblyStage` picks it up.
   *
   * Skipped silently in the following cases — none of them are errors:
   *   - plugin disabled
   *   - mind service not registered (avatar-only deployment)
   *   - mind.enabled=false (config opt-out)
   *   - mind.promptPatch.enabled=false (A/B opt-out)
   *   - phenotype unremarkable and no relationship data (empty fragment)
   */
  @Hook({ stage: 'onMessagePreprocess', priority: 'NORMAL', order: 10 })
  async onMessagePreprocess(context: HookContext): Promise<boolean> {
    if (!this.enabled || !this.mind) return true;
    if (!this.mind.isEnabled()) return true;
    try {
      // Prefer message-level userId; fall back to metadata (e.g. in some test paths).
      const userId = String(context.message?.userId ?? context.metadata.get('userId') ?? '');
      const fragment = await this.mind.getPromptPatchFragmentAsync(userId ? { userId } : undefined);
      if (!fragment) return true;
      const existing = context.metadata.get('systemPromptFragments') ?? [];
      context.metadata.set('systemPromptFragments', [...existing, fragment]);
      logger.debug(`[MindPromptPlugin] injected mind fragment | len=${fragment.length}`);
    } catch (err) {
      logger.warn('[MindPromptPlugin] fragment assembly failed (non-fatal):', err);
    }
    return true;
  }

  /**
   * COMPLETE hook: update the persona↔user relationship based on the
   * user's message text. Uses the coarse keyword classifier in
   * `RelationshipUpdater`. Failures are swallowed — never breaks reply flow.
   */
  @Hook({ stage: 'onMessageComplete', priority: 'NORMAL', order: 10 })
  async onMessageComplete(context: HookContext): Promise<boolean> {
    if (!this.enabled || !this.mind || !this.relationshipUpdater) return true;
    if (!this.mind.isEnabled()) return true;
    try {
      // Only update relationship when an actual reply was produced.
      const reply = getReply(context);
      if (!reply) return true;
      // Prefer message-level userId; fall back to metadata.
      const userId = String(context.message?.userId ?? context.metadata.get('userId') ?? '');
      if (!userId || userId === '0') return true;
      // Read user's message text for affinity classification. `message` is always present; rawMessage is optional.
      const userText = context.message?.message ?? context.message?.rawMessage ?? '';
      const personaId = this.mind.getConfig().personaId;
      await this.relationshipUpdater.update(personaId, userId, userText);
      logger.debug(`[MindPromptPlugin] relationship bumped | persona=${personaId} user=${userId}`);
    } catch (err) {
      logger.warn('[MindPromptPlugin] relationship update failed (non-fatal):', err);
    }
    return true;
  }
}
