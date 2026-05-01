// Mind Prompt Plugin — injects the mind subsystem's state-derived mood
// fragment into the reply pipeline's system prompt, and updates the
// persona↔user relationship after each reply completes.
//
// Does nothing when mind is disabled, when the patch is empty, or when
// the mind service hasn't been registered (e.g. tests / minimal
// bootstraps). The plugin is pure wiring: all translation logic lives
// in `PersonaService.getPromptPatchFragmentAsync()` and further upstream in
// `mind/prompt/PromptPatchAssembler.ts`.

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { getReply } from '@/context/HookContextHelpers';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { PersonaService } from '@/persona';
import type { EpigeneticsStore } from '@/persona/reflection/epigenetics/EpigeneticsStore';
import { ReflectionEngine } from '@/persona/reflection/ReflectionEngine';
import { RelationshipUpdater } from '@/persona/reflection/relationships/RelationshipUpdater';
import type { ToolManager } from '@/tools/ToolManager';
import { logger } from '@/utils/logger';
import { Hook, RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

@RegisterPlugin({
  name: 'persona-completion',
  version: '1.0.0',
  description: 'Injects mind-state mood fragment into the reply pipeline system prompt',
})
export class PersonaCompletionHookPlugin extends PluginBase {
  private persona: PersonaService | null = null;
  private relationshipUpdater: RelationshipUpdater | null = null;
  private reflectionEngine: ReflectionEngine | null = null;

  async onInit(): Promise<void> {
    const container = getContainer();
    // PERSONA_SERVICE is required (DITokens.ts) — resolve directly.
    this.persona = container.resolve<PersonaService>(DITokens.PERSONA_SERVICE);

    // EPIGENETICS_STORE is optional (SQLite-only). Without it there's no
    // place to persist relationships or epigenetics, so RelationshipUpdater
    // and ReflectionEngine are intentionally skipped on MongoDB.
    if (!container.isRegistered(DITokens.EPIGENETICS_STORE)) return;
    const store = container.resolve<EpigeneticsStore>(DITokens.EPIGENETICS_STORE);
    this.persona.setEpigeneticsStore(store);
    this.relationshipUpdater = new RelationshipUpdater(store);

    // All other deps are required tokens (DITokens.ts) — resolve directly.
    // If any is missing, the resolve call throws and PluginManager surfaces
    // an aggregate error to bootstrap, which is the signal we want.
    const llmService = container.resolve<LLMService>(DITokens.LLM_SERVICE);
    const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    const historyService = container.resolve<ConversationHistoryService>(DITokens.CONVERSATION_HISTORY_SERVICE);
    const toolManager = container.resolve<ToolManager>(DITokens.TOOL_MANAGER);
    const hookManager = container.resolve<HookManager>(DITokens.HOOK_MANAGER);
    const personaId = this.persona.getConfig().personaId;

    this.reflectionEngine = new ReflectionEngine(
      store,
      this.persona,
      llmService,
      promptManager,
      historyService,
      { personaId },
      toolManager,
      hookManager,
    );
    this.reflectionEngine.start();
    logger.info('[PersonaCompletionHookPlugin] ReflectionEngine started');
  }

  /**
   * COMPLETE hook: update the persona↔user relationship based on the
   * user's message text. Uses the coarse keyword classifier in
   * `RelationshipUpdater`. Failures are swallowed — never breaks reply flow.
   */
  @Hook({
    stage: 'onMessageComplete',
    priority: 'NORMAL',
    order: 10,
    // Reflection / relationship updates only make sense for real-user IM
    // exchanges. Synthetic-event sources (avatar-cmd / bilibili-danmaku /
    // idle-trigger / bootstrap) carry sentinel userIds and shouldn't drive
    // System-2 reflection or `persona_relationships`.
    applicableSources: ['qq-private', 'qq-group', 'discord'],
  })
  async onMessageComplete(context: HookContext): Promise<boolean> {
    if (!this.enabled || !this.persona || !this.relationshipUpdater) return true;
    if (!this.persona.isEnabled()) return true;
    // Runtime user-config gate (decorator's applicableSources is the
    // synthetic-exclusion baseline; user can further narrow via
    // mind.applicableSources, e.g. ['qq-private'] for DM-only test).
    if (!this.persona.isApplicableSource(context.source)) return true;
    try {
      // Only update relationship when an actual reply was produced.
      const reply = getReply(context);
      if (!reply) return true;
      // Prefer message-level userId; fall back to metadata.
      const userId = String(context.message?.userId ?? context.metadata.get('userId') ?? '');
      if (!userId || userId === '0') return true;
      // Read user's message text for affinity classification. `message` is always present; rawMessage is optional.
      const userText = context.message?.message ?? context.message?.rawMessage ?? '';
      const personaId = this.persona.getConfig().personaId;
      await this.relationshipUpdater.update(personaId, userId, userText);
      logger.debug(`[PersonaCompletionHookPlugin] relationship bumped | persona=${personaId} user=${userId}`);

      // Fire-and-forget event reflection — runs async, never blocks reply.
      if (this.reflectionEngine) {
        const groupId = context.message?.groupId;
        this.reflectionEngine.enqueueEventReflection(userText, groupId != null ? { groupId } : undefined);
      }
    } catch (err) {
      logger.warn('[PersonaCompletionHookPlugin] relationship update failed (non-fatal):', err);
    }
    return true;
  }
}
