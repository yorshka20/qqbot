// Gate check stage — whitelist capability + hook gates.

import { hasWhitelistCapability } from '@/context/HookContextHelpers';
import type { HookManager } from '@/hooks/HookManager';
import { WHITELIST_CAPABILITY } from '@/utils/whitelistCapabilities';
import type { ReplyPipelineContext } from '../ReplyPipelineContext';
import type { ReplyStage } from '../types';

/**
 * Pipeline stage 1: gate checks.
 * Verifies whitelist capability and fires `onMessageBeforeAI` / `onAIGenerationStart` hooks.
 * Sets `ctx.interrupted = true` when the group lacks reply permission, causing the pipeline to exit early.
 */
export class GateCheckStage implements ReplyStage {
  readonly name = 'gate-check';

  constructor(private hookManager: HookManager) {}

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

    // Hook: onMessageBeforeAI
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', hookContext);
    if (!shouldContinue) {
      throw new Error('Reply generation interrupted by hook');
    }

    // Hook: onAIGenerationStart
    await this.hookManager.execute('onAIGenerationStart', hookContext);
  }
}
