// PromptAssemblyStage — produces the system prompt fed to the LLM.
//
// Two inputs:
//   - Source-specific template (e.g. `avatar.speak-system` for /avatar,
//     `avatar.bilibili-batch-system` for danmaku batches)
//   - Live action-map from the avatar, formatted as Markdown bullets so the
//     LLM picks from actions that actually exist in the current config
//
// Variables injected into the template:
//   - `availableActions`: string of formatted bullets, always present
//     (empty list when the avatar exposes no actions — template renders
//     cleanly either way)
//
// Future enhancements (natural fit here):
//   - Inject recent memory / per-user persona under a new variable
//   - Source-specific variable packs (mood, viewer count, streamer state)
//   - Prompt caching keys derived from the assembled prompt

import { formatActionsForPrompt } from '@qqbot/avatar';
import { inject, injectable } from 'tsyringe';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
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

  constructor(@inject(DITokens.PROMPT_MANAGER) private promptManager: PromptManager) {}

  async execute(ctx: Live2DContext): Promise<void> {
    if (!ctx.avatar) return;

    ctx.availableActions = formatActionsForPrompt(ctx.avatar.listActions());

    const templateName = TEMPLATE_BY_SOURCE[ctx.input.source];
    try {
      ctx.systemPrompt = this.promptManager.render(templateName, {
        availableActions: ctx.availableActions,
      });
    } catch (err) {
      logger.error(`[Live2D/prompt-assembly] template "${templateName}" render failed:`, err);
      ctx.skipped = true;
      ctx.skipReason = 'prompt-render-failed';
    }
  }
}
