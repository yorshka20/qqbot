// TagAnimationStage — parse `[LIVE2D: emotion=..., action=..., intensity=...]`
// tags out of the LLM reply and enqueue each as a discrete animation onto
// the avatar's compiler. State transitions (pose) are NOT touched here —
// those are orchestrator-level plumbing around the whole pipeline.
//
// This stage is tolerant by design: a tag-parse failure or an unknown
// action name logs a warning but doesn't mark the context as skipped,
// because the spoken reply (next stage) still delivers value even if the
// visual layer misbehaves.
//
// Future enhancements (natural fit here):
//   - Tag post-processing (dedup, intensity clamping, emotion remap)
//   - Config-driven tag deny-list (disable certain actions in certain sources)
//   - Parallel-action scheduling (instead of strict sequential enqueue)

import { parseLive2DTags } from '@qqbot/avatar';
import { injectable } from 'tsyringe';
import { logger } from '@/utils/logger';
import type { Live2DContext, Live2DStage } from '../Live2DStage';

@injectable()
export class TagAnimationStage implements Live2DStage {
  readonly name = 'tag-animation';

  async execute(ctx: Live2DContext): Promise<void> {
    if (!ctx.avatar || !ctx.replyText) return;
    // Streaming path already enqueued tags chunk-by-chunk; don't re-enqueue.
    if (ctx.streamingHandled) return;

    try {
      const tags = parseLive2DTags(ctx.replyText);
      for (const tag of tags) {
        ctx.avatar.enqueueTagAnimation(tag);
      }
      ctx.tagCount = tags.length;
    } catch (err) {
      logger.warn('[Live2D/tag-animation] parse/enqueue failed (non-fatal):', err);
      ctx.tagCount = 0;
    }
  }
}
