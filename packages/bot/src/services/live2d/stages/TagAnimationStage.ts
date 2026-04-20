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
import type { Live2DContext, Live2DStage } from '../Live2DStage';

const HOLD_MULTIPLIERS: Record<'brief' | 'short' | 'long', number> = {
  brief: 0.5,
  short: 0.8,
  long: 1.4,
};

@injectable()
export class TagAnimationStage implements Live2DStage {
  readonly name = 'tag-animation';

  async execute(ctx: Live2DContext): Promise<void> {
    if (!ctx.avatar || !ctx.replyText) return;
    // Streaming path already enqueued tags chunk-by-chunk; don't re-enqueue.
    if (ctx.streamingHandled) return;

    try {
      const tags = parseRichTags(ctx.replyText);
      for (const tag of tags) {
        switch (tag.kind) {
          case 'action': {
            const mult = ctx.pendingHoldMultiplier;
            ctx.pendingHoldMultiplier = undefined;
            const payload: {
              action: string;
              emotion: string;
              intensity: number;
              durationOverrideMs?: number;
            } = {
              action: tag.action,
              emotion: tag.emotion,
              intensity: tag.intensity,
            };
            if (mult !== undefined) {
              // Pre-compute hold-adjusted base duration so enqueueTagAnimation
              // applies jitter on top of the scaled value, not the raw registered
              // duration. Falls back to 1500ms matching enqueueTagAnimation's own
              // fallback so the multiplier is never lost.
              const registered = ctx.avatar.getActionDuration?.(tag.action);
              const base = registered ?? 1500;
              payload.durationOverrideMs = Math.max(1, Math.round(base * mult));
            }
            ctx.avatar.enqueueTagAnimation(payload);
            break;
          }
          case 'emotion':
            ctx.avatar.enqueueEmotion(tag.emotion, tag.intensity);
            break;
          case 'gaze':
            ctx.avatar.setGazeTarget(tag.target);
            break;
          case 'hold':
            ctx.pendingHoldMultiplier = HOLD_MULTIPLIERS[tag.dur];
            break;
        }
      }
      // Drop any unconsumed hold — stage boundary is per-reply.
      ctx.pendingHoldMultiplier = undefined;
      ctx.tagCount = tags.length;
    } catch (err) {
      logger.warn('[Live2D/tag-animation] parse/enqueue failed (non-fatal):', err);
      ctx.tagCount = 0;
    }
  }
}
