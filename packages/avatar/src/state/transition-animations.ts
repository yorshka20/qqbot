import type { AvatarPose, StateNodeOutput } from './types';

/**
 * Discrete animation payloads enqueued the moment `AvatarActivity.pose`
 * changes to `<key>`.
 *
 * - `neutral`: empty. Ambient layers (blink, gaze, idle-motion) already
 *   produce natural idle life; transitioning back to neutral just releases the
 *   pose — the low-pass smoothing in AnimationCompiler returns channels to
 *   baseline on its own.
 * - `listening`: empty. The previous `lean_forward` cue was Cubism-only and
 *   had no effect on VRM, so it was retired with the core action-map cleanup.
 * - `thinking`: continuous thinking pose (duration=0 = hold until next pose
 *   change — the compiler's ADSR treats 0 duration as instant attack then
 *   indefinite sustain).
 *
 * Old `BotState` had five entries (idle/listening/thinking/speaking/reacting)
 * but `speaking`/`reacting` were always empty — their effect now lives in
 * `ambientGain` (see types.ts). LLM tag output drives speaking / reaction
 * animations directly through `enqueueTagAnimation`, not here.
 */
export const TRANSITION_ANIMATIONS: Record<AvatarPose, StateNodeOutput[]> = {
  neutral: [],
  listening: [],
  thinking: [
    { action: 'emotion_thinking', emotion: 'neutral', intensity: 0.6, duration: 0, easing: 'easeInOutCubic' },
  ],
};
