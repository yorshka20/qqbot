// Gate check stage — whitelist capability, per-user budget, hook gates.

import { inject, singleton } from 'tsyringe';
import { hasWhitelistCapability, replaceReply } from '@/context/HookContextHelpers';
import { HookManager } from '@/hooks/HookManager';
import { UsageBudgetService } from '@/services/tokenUsage/UsageBudgetService';
import { WHITELIST_CAPABILITY } from '@/utils/whitelistCapabilities';
import type { ReplyPipelineContext } from '../ReplyPipelineContext';
import type { ReplyStage } from '../types';

/**
 * Pipeline stage 1: gate checks.
 * Verifies whitelist capability and the sender's daily budget, then fires
 * `onMessageBeforeAI` / `onAIGenerationStart` hooks.
 * Sets `ctx.interrupted = true` when the group lacks reply permission or the sender is
 * over budget, causing the pipeline to exit early.
 */
@singleton()
export class GateCheckStage implements ReplyStage {
  readonly name = 'gate-check';

  constructor(
    @inject(HookManager) private hookManager: HookManager,
    @inject(UsageBudgetService) private budgetService: UsageBudgetService,
  ) {}

  async execute(ctx: ReplyPipelineContext): Promise<void> {
    const { hookContext } = ctx;

    // Gate: do not run any LLM when access denied or group lacks reply capability.
    if (hookContext.metadata.get('whitelistDenied')) {
      ctx.interrupted = true;
      return;
    }
    if (!hasWhitelistCapability(hookContext, WHITELIST_CAPABILITY.reply)) {
      ctx.interrupted = true;
      return;
    }

    // Before the hooks: onMessageBeforeAI runs the reply-mode classifier, itself an LLM call.
    const exceeded = await this.budgetService.checkUser(
      String(hookContext.message.userId),
      hookContext.message.protocol,
    );
    if (exceeded) {
      replaceReply(
        hookContext,
        `你今天的 AI 额度用完了（$${exceeded.spentUsd.toFixed(2)} / $${exceeded.limitUsd.toFixed(2)}），明天自动恢复。`,
        'ai',
      );
      ctx.interrupted = true;
      return;
    }

    // Hook: onMessageBeforeAI
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', hookContext);
    if (!shouldContinue) {
      throw new Error('Reply generation interrupted by hook');
    }

    // Hook: onAIGenerationStart
    await this.hookManager.execute('onAIGenerationStart', hookContext);
  }
}
