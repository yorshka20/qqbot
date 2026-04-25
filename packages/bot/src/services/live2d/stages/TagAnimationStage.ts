// TagAnimationStage — parse rich animation tags out of the LLM reply and
// route each to the appropriate AvatarService entry:
//
//   [A:action@intensity]  → enqueueTagAnimation (action slot)
//   [E:emotion@intensity] → enqueueEmotion      (persistent baseline)
//   [G:target]            → setGazeTarget        (eye-gaze layer)
//   [H:brief|short|long]  → stash duration multiplier for next [A:...]
//   [LIVE2D: ...]         → legacy format, handled by parseRichTags shim
//
// The stage is tolerant by design: a tag-parse failure or an unknown
// action name logs a warning but doesn't mark the context as skipped,
// because the spoken reply (next stage) still delivers value even if the
// visual layer misbehaves.

import { parseRichTags } from '@qqbot/avatar';
import { injectable } from 'tsyringe';
import { logger } from '@/utils/logger';
import { dispatchTags } from '../dispatchParsedTag';
import type { Live2DContext, Live2DStage } from '../Live2DStage';

@injectable()
export class TagAnimationStage implements Live2DStage {
  readonly name = 'tag-animation';

  async execute(ctx: Live2DContext): Promise<void> {
    if (!ctx.avatar || !ctx.replyText) return;
    // Streaming path already enqueued tags chunk-by-chunk; don't re-enqueue.
    if (ctx.streamingHandled) return;

    try {
      const tags = parseRichTags(ctx.replyText);
      dispatchTags(tags, ctx, ctx.avatar);
      // Drop any unconsumed hold — stage boundary is per-reply.
      ctx.pendingHoldMultiplier = undefined;
      ctx.tagCount = tags.length;
    } catch (err) {
      logger.warn('[Live2D/tag-animation] parse/enqueue failed (non-fatal):', err);
      ctx.tagCount = 0;
    }
  }
}
