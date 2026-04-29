// Mind Prompt Plugin — injects the mind subsystem's state-derived mood
// fragment into the reply pipeline's system prompt, and updates the
// persona↔user relationship after each reply completes.
//
// Does nothing when mind is disabled, when the patch is empty, or when
// the mind service hasn't been registered (e.g. tests / minimal
// bootstraps). The plugin is pure wiring: all translation logic lives
// in `MindService.getPromptPatchFragmentAsync()` and further upstream in
// `mind/prompt/PromptPatchAssembler.ts`.

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { getReply } from '@/context/HookContextHelpers';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import type { MindService } from '@/mind';
import type { EpigeneticsStore } from '@/mind/epigenetics/EpigeneticsStore';
import { ReflectionEngine } from '@/mind/reflection/ReflectionEngine';
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
  private reflectionEngine: ReflectionEngine | null = null;

  async onInit(): Promise<void> {
    const container = getContainer();
    if (container.isRegistered(DITokens.MIND_SERVICE)) {
      this.mind = container.resolve<MindService>(DITokens.MIND_SERVICE);
    }
    if (this.mind && container.isRegistered(DITokens.EPIGENETICS_STORE)) {
      const store = container.resolve<EpigeneticsStore>(DITokens.EPIGENETICS_STORE);
      this.mind.setEpigeneticsStore(store);
      this.relationshipUpdater = new RelationshipUpdater(store);

      // Build + start ReflectionEngine when all required services are present.
      if (
        container.isRegistered(DITokens.LLM_SERVICE) &&
        container.isRegistered(DITokens.PROMPT_MANAGER) &&
        container.isRegistered(DITokens.CONVERSATION_HISTORY_SERVICE)
      ) {
        try {
          const llmService = container.resolve<LLMService>(DITokens.LLM_SERVICE);
          const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
          const historyService = container.resolve<ConversationHistoryService>(DITokens.CONVERSATION_HISTORY_SERVICE);
          const personaId = this.mind.getConfig().personaId;
          this.reflectionEngine = new ReflectionEngine(store, this.mind, llmService, promptManager, historyService, {
            personaId,
          });
          this.reflectionEngine.start();
          logger.info('[MindPromptPlugin] ReflectionEngine started');
        } catch (err) {
          logger.warn('[MindPromptPlugin] ReflectionEngine init failed (non-fatal):', err);
        }
      }
    }
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

      // Fire-and-forget event reflection — runs async, never blocks reply.
      if (this.reflectionEngine) {
        const groupId = context.message?.groupId;
        this.reflectionEngine.enqueueEventReflection(userText, groupId != null ? { groupId } : undefined);
      }
    } catch (err) {
      logger.warn('[MindPromptPlugin] relationship update failed (non-fatal):', err);
    }
    return true;
  }
}
