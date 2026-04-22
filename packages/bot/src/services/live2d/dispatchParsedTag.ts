// Shared tag dispatcher — called from both the streaming flush path
// (LLMStage's SentenceFlusher) and the non-streaming path (TagAnimationStage).
// Keeping them in one place ensures that `[E:]` / `[G:]` / `[H:]` / `[W:]`
// dispatch identically whether the LLM streamed or returned a single reply.

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
