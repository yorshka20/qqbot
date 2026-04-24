/**
 * Autonomous wander — types.
 *
 * "Wander" = periodic, low-amplitude idle motion that simulates a person
 * not holding still (weight shifts, glances, tiny steps, brief
 * look-arounds). Purely body-level; does not interact with reply
 * generation, mood tags, or any LLM path.
 *
 * Design notes:
 *  - Intents are *sequences* of steps (turn-hold-turn-back, strafe-hold)
 *    rather than single actions. This is what the user called "散步意图
 *    连续感": one wander firing should read as a coherent micro-behavior,
 *    not a random twitch.
 *  - All amplitudes are deliberately small. Intent is "the avatar is
 *    alive but currently idle," not "the avatar is dancing".
 *  - Intents are picked by weighted random; weights tunable in config.
 */

import type { GazeTarget, HeadLookTarget } from '@qqbot/avatar';

/** One discrete step inside an intent; executed sequentially. */
export type WanderStep =
  | { kind: 'turn'; radians: number }
  | { kind: 'walkForward'; meters: number }
  | { kind: 'strafe'; meters: number }
  | { kind: 'setGaze'; target: GazeTarget }
  // setHead targets the HeadLookLayer — rotates head only (body stays put). `null`
  // releases the override and the head drifts back to neutral.
  | { kind: 'setHead'; target: HeadLookTarget | null }
  | { kind: 'wait'; ms: number };

/**
 * A wander "intent" — a short sequence of steps with a label. Label is
 * observational only (logs / HUD); it does not affect execution.
 */
export interface WanderIntent {
  label: WanderIntentKind;
  steps: WanderStep[];
}

export type WanderIntentKind = 'glance' | 'look_around' | 'shift_weight' | 'micro_step' | 'browse';

/** Adapter the scheduler calls to actually drive the avatar. */
export interface WanderExecutor {
  /** Current pose label — 'neutral' means idle and eligible to wander. */
  getCurrentPose(): string;
  /** Returns true when the avatar subsystem is up (ready to accept calls). */
  isAvatarActive(): boolean;
  walkForward(meters: number): Promise<void>;
  strafe(meters: number): Promise<void>;
  turn(radians: number): Promise<void>;
  setGazeTarget(target: GazeTarget | null): void;
  setHeadLook(target: HeadLookTarget | null): void;
}
