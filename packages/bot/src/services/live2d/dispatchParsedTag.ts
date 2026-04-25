// Shared tag dispatcher — called from both the streaming flush path
// (LLMStage's SentenceFlusher) and the non-streaming path (TagAnimationStage).
// Keeping them in one place ensures that `[E:]` / `[G:]` / `[H:]` / `[W:]`
// dispatch identically whether the LLM streamed or returned a single reply.
//
// Preferred entry-point is `dispatchTags()` (batch), which vector-merges
// consecutive [W:forward] / [W:strafe] / [W:turn] tags into one walkRelative()
// call before issuing any motion. `dispatchParsedTag()` remains for callers
// that process one tag at a time (e.g. ad-hoc tool callers).

import type { AvatarService, ParsedTag, WalkMotion } from '@qqbot/avatar';
import { logger } from '@/utils/logger';
import type { Live2DContext } from './Live2DStage';

const HOLD_MULTIPLIERS: Record<'brief' | 'short' | 'long', number> = {
  brief: 0.5,
  short: 0.8,
  long: 1.4,
};

/**
 * Dispatch one parsed tag to the avatar. Mutates `ctx.pendingHoldMultiplier`
 * for hold-tag state that carries across calls (and across streaming chunks).
 * Walk-tag primitives no-op on cubism models (`WalkingLayer` absent).
 */
export function dispatchParsedTag(tag: ParsedTag, ctx: Live2DContext, avatar: AvatarService): void {
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
        const registered = avatar.getActionDuration?.(tag.action);
        const base = registered ?? 1500;
        payload.durationOverrideMs = Math.max(1, Math.round(base * mult));
      }
      avatar.enqueueTagAnimation(payload);
      break;
    }
    case 'emotion':
      avatar.enqueueEmotion(tag.emotion, tag.intensity);
      break;
    case 'gaze':
      avatar.setGazeTarget(tag.target);
      break;
    case 'hold':
      ctx.pendingHoldMultiplier = HOLD_MULTIPLIERS[tag.dur];
      break;
    case 'walk':
      dispatchWalk(tag.motion, avatar);
      break;
    case 'headLook':
      avatar.setHeadLook(tag.target);
      break;
  }
}

function dispatchWalk(motion: WalkMotion, avatar: AvatarService): void {
  const swallow = (p: Promise<void>): void => {
    p.catch((err) => logger.debug('[Live2D/walk] dispatch rejected (non-fatal):', err));
  };
  switch (motion.type) {
    case 'forward':
      swallow(avatar.walkForward(motion.meters));
      break;
    case 'strafe':
      swallow(avatar.strafe(motion.meters));
      break;
    case 'turn':
      swallow(avatar.turn((motion.degrees * Math.PI) / 180));
      break;
    case 'orbit':
      swallow(
        avatar.orbit({
          sweepRad: (motion.degrees * Math.PI) / 180,
          ...(motion.radius !== undefined ? { radius: motion.radius } : {}),
        }),
      );
      break;
    case 'to':
      swallow(avatar.walkToSemantic(motion.target));
      break;
    case 'face':
      swallow(avatar.faceSemantic(motion.target));
      break;
    case 'stop':
      avatar.stopMotion();
      break;
  }
}

/** Mutable accumulator for vector-merged relative walk deltas. */
interface RelativeWalkBuffer {
  forwardMeters: number;
  strafeMeters: number;
  turnRadians: number;
}

/** Flush non-zero relative walk buffer as one walkRelative() call, then zero it out. */
function flushRelativeWalk(buf: RelativeWalkBuffer, avatar: AvatarService): void {
  if (buf.forwardMeters === 0 && buf.strafeMeters === 0 && buf.turnRadians === 0) return;
  const p = avatar.walkRelative(buf.forwardMeters, buf.strafeMeters, buf.turnRadians);
  p.catch((err) => logger.debug('[Live2D/walk] dispatch rejected (non-fatal):', err));
  buf.forwardMeters = 0;
  buf.strafeMeters = 0;
  buf.turnRadians = 0;
}

/**
 * Dispatch a sequence of parsed tags to the avatar, vector-merging consecutive
 * [W:forward], [W:strafe], and [W:turn] tags into a single walkRelative() call.
 *
 * Non-mergeable walk types (`to`, `face`, `orbit`, `stop`) and non-walk tags
 * (`action`, `emotion`, `gaze`, `hold`) flush any pending relative-walk buffer
 * before executing their own dispatch logic.
 *
 * The buffer is local to each call — there is no cross-chunk state. Streaming
 * callers should invoke dispatchTags() once per flushed chunk; chunk boundaries
 * act as natural buffer flush points.
 */
export function dispatchTags(tags: ParsedTag[], ctx: Live2DContext, avatar: AvatarService): void {
  const buf: RelativeWalkBuffer = { forwardMeters: 0, strafeMeters: 0, turnRadians: 0 };

  for (const tag of tags) {
    if (tag.kind === 'walk') {
      const motion = tag.motion;
      if (motion.type === 'forward') {
        buf.forwardMeters += motion.meters;
      } else if (motion.type === 'strafe') {
        buf.strafeMeters += motion.meters;
      } else if (motion.type === 'turn') {
        buf.turnRadians += (motion.degrees * Math.PI) / 180;
      } else {
        // Non-mergeable walk: flush buffered relative motion first, then dispatch.
        flushRelativeWalk(buf, avatar);
        dispatchWalk(motion, avatar);
      }
    } else {
      // Non-walk tag: flush buffered relative motion first, then dispatch normally.
      flushRelativeWalk(buf, avatar);
      dispatchParsedTag(tag, ctx, avatar);
    }
  }

  // Flush any remaining accumulated relative motion at end of the tag sequence.
  flushRelativeWalk(buf, avatar);
}
