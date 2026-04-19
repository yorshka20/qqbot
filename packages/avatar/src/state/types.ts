/**
 * Pose drives the discrete transition animation enqueued when the bot's
 * engagement shape changes. Only three entries have non-empty animation
 * payloads — everything else is covered by `ambientGain` + discrete tag
 * animations from LLM replies.
 */
export type AvatarPose = 'neutral' | 'listening' | 'thinking';

/**
 * Runtime "activity" describing how the bot currently wants ambient animation
 * to behave. Replaces the old single-enum `BotState`, which conflated three
 * orthogonal concerns (ambient gain, idle-motion gating, pose transition) into
 * one value.
 *
 * - `ambientGain`: multiplier applied to every registered AnimationLayer.
 *   1.0 = full ambient life (breath/blink/gaze/idle-motion at normal volume);
 *   0.3 = mostly silenced so discrete tag animations dominate (e.g. while
 *   speaking). Layers that must keep running regardless (gaze) modulate
 *   themselves inside `sample()`.
 *
 * - `pose`: the semantic posture the bot is adopting right now. Drives the
 *   `TRANSITION_ANIMATIONS[pose]` lookup — only `listening` (lean_forward) and
 *   `thinking` (thinking pose) have non-empty payloads; `neutral` returns the
 *   avatar to the default stance.
 *
 * Most consumers only care about one axis; the two dimensions evolve
 * independently. Example: while speaking, `ambientGain` drops to 0.3 but
 * `pose` stays `neutral` — the lean_forward / thinking poses aren't involved.
 */
export interface AvatarActivity {
  ambientGain: number;
  pose: AvatarPose;
}

export const DEFAULT_ACTIVITY: AvatarActivity = {
  ambientGain: 1.0,
  pose: 'neutral',
};

/** Partial update — undefined fields keep their current value. */
export type AvatarActivityPatch = Partial<AvatarActivity>;

/**
 * Custom defined in this module, structure consistent with StateNode in src/avatar/compiler/types.ts.
 * Do not import compiler types to avoid circular dependency —— integration ticket will unify types.
 */
export interface StateNodeOutput {
  action: string;
  emotion: string;
  intensity: number;
  /** Milliseconds. 0 means continuous until next state change (used for thinking). */
  duration: number;
  delay?: number;
  easing: string;
  timestamp?: number;
}

export interface IdleConfig {
  /** Lower bound of random idle animation interval (ms), default 3000 */
  idleIntervalMin: number;
  /** Upper bound of random idle animation interval (ms), default 8000 */
  idleIntervalMax: number;
}

export const DEFAULT_IDLE_CONFIG: IdleConfig = {
  idleIntervalMin: 3000,
  idleIntervalMax: 8000,
};
