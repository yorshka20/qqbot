// PromptAssemblyStage — produces the LLM-ready message list for this run.
//
// Responsibility has grown from "render a template" to "assemble the full
// prompt": template-rendered sceneSystem + rolling thread history (via
// Live2DSessionService) + optional memory context + the current query.
//
// Template inputs (unchanged):
//   - `availableActions`: live action-map from the avatar, rendered as
//     Markdown bullets so the LLM picks from actions that actually exist.
//
// Context slots populated:
//   - `availableActions`, `systemPrompt` (for logging / back-compat tests)
//   - `threadId`   → the session thread id owning this scope (used by
//     LLMStage to append the user input + reply on success)
//   - `messages`   → the final ChatMessage[] that LLMStage forwards to the
//     LLM (system + scene system + history entries + final user block)

import { formatActionsForPrompt } from '@qqbot/avatar';
import { inject, injectable } from 'tsyringe';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { PromptMessageAssembler } from '@/ai/prompt/PromptMessageAssembler';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { MemoryService } from '@/memory/MemoryService';
import { logger } from '@/utils/logger';
import type { Live2DSessionService } from '../Live2DSessionService';
import type { Live2DContext, Live2DStage } from '../Live2DStage';
import type { Live2DSource } from '../types';

/** Source → template name mapping. Templates live under `prompts/avatar/`. */
const TEMPLATE_BY_SOURCE: Record<Live2DSource, string> = {
  'avatar-cmd': 'avatar.speak-system',
  'bilibili-danmaku-batch': 'avatar.bilibili-batch-system',
};

@injectable()
export class PromptAssemblyStage implements Live2DStage {
  readonly name = 'prompt-assembly';
  private readonly messageAssembler = new PromptMessageAssembler();

  constructor(
    @inject(DITokens.PROMPT_MANAGER) private promptManager: PromptManager,
    @inject(DITokens.LIVE2D_SESSION_SERVICE) private sessionService: Live2DSessionService,
  ) {}

  async execute(ctx: Live2DContext): Promise<void> {
    if (!ctx.avatar) return;

    ctx.availableActions = formatActionsForPrompt(ctx.avatar.listActions());

    const templateName = TEMPLATE_BY_SOURCE[ctx.input.source];
    let sceneSystem: string;
    try {
      sceneSystem = this.promptManager.render(templateName, {
        availableActions: ctx.availableActions,
      });
    } catch (err) {
      logger.error(`[Live2D/prompt-assembly] template "${templateName}" render failed:`, err);
      ctx.skipped = true;
      ctx.skipReason = 'prompt-render-failed';
      return;
    }
    ctx.systemPrompt = sceneSystem;

    // Session thread: lazily created on first use per (source, scope).
    const scope = this.resolveScope(ctx);
    ctx.threadId = this.sessionService.ensureThread(ctx.input.source, scope);
    const historyEntries = this.sessionService.getHistoryEntries(ctx.threadId);

    // Optional memory context. MemoryService expects a `groupId` — reuse the
    // session's groupId so memory is scoped to this Live2D session, not to
    // any real QQ group. When MemoryService isn't in the container (tests,
    // minimal deployments), skip silently.
    const memoryContext = await this.resolveMemoryContext(ctx);

    ctx.messages = this.messageAssembler.buildNormalMessages({
      baseSystem: undefined,
      sceneSystem,
      historyEntries,
      finalUserBlocks: {
        memoryContext,
        currentQuery: ctx.input.text,
      },
    });
  }

  /**
   * Derive a sub-scope for multi-tenant sources. avatar-cmd is global by
   * design; bilibili-danmaku-batch could carry a roomId in meta when
   * multi-room support lands; livemode would carry the userId.
   */
  private resolveScope(ctx: Live2DContext): string | undefined {
    const meta = ctx.input.meta ?? {};
    const roomId = meta.roomId;
    if (typeof roomId === 'string' && roomId) return roomId;
    const scope = meta.scope;
    if (typeof scope === 'string' && scope) return scope;
    return undefined;
  }

  private async resolveMemoryContext(ctx: Live2DContext): Promise<string | undefined> {
    const container = getContainer();
    if (!container.isRegistered(DITokens.MEMORY_SERVICE)) return undefined;
    try {
      const memoryService = container.resolve<MemoryService>(DITokens.MEMORY_SERVICE);
      const groupId = ctx.threadId ? this.groupIdFromThread(ctx) : '';
      if (!groupId) return undefined;
      const userId = ctx.input.sender?.uid;
      const result = await memoryService.getFilteredMemoryForReplyAsync(groupId, userId, {
        userMessage: ctx.input.text,
        alwaysIncludeScopes: ['instruction', 'rule'],
        minRelevanceScore: 0.7,
      });
      const parts: string[] = [];
      if (result.groupMemoryText?.trim()) parts.push(result.groupMemoryText.trim());
      if (result.userMemoryText?.trim()) parts.push(result.userMemoryText.trim());
      return parts.length > 0 ? parts.join('\n\n') : undefined;
    } catch (err) {
      logger.debug('[Live2D/prompt-assembly] memory resolve skipped (non-fatal):', err);
      return undefined;
    }
  }

  /**
   * Recover the groupId the session service used for this thread. We don't
   * persist it on the ctx to avoid leaking implementation details, but
   * memory lookups need a consistent scope key. The session's thread's
   * owning group is the right key.
   */
  private groupIdFromThread(ctx: Live2DContext): string {
    // Session service scopes by `live2d:<source>[:<scope>]`. Reuse the same
    // convention here (matches Live2DSessionService.resolveGroupId).
    const source = ctx.input.source;
    const scope = this.resolveScope(ctx);
    if (source === 'avatar-cmd') return 'live2d:avatar-cmd:global';
    if (source === 'bilibili-danmaku-batch') {
      return scope ? `live2d:bilibili-live:${scope}` : 'live2d:bilibili-live';
    }
    return scope ? `live2d:${source}:${scope}` : `live2d:${source}`;
  }
}
