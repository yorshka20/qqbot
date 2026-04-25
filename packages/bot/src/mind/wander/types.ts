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
  // playIdleClip enqueues a clip-kind action via the discrete pipeline so the
  // unified idle scheduler can pick "play an idle clip" alongside translation
  // / turn / gaze steps. Footprint is empty at the wander layer — the action
  // map's enqueue path runs its own cross-action conflict check.
  | { kind: 'playIdleClip'; actionName: string }
  | { kind: 'wait'; ms: number };

/**
 * A wander "intent" — a short sequence of steps with a label. Label is
 * observational only (logs / HUD); it does not affect execution.
 */
export interface WanderIntent {
  label: WanderIntentKind;
  steps: WanderStep[];
}

export type WanderIntentKind =
  | 'glance'
  | 'look_around'
  | 'shift_weight'
  | 'micro_step'
  | 'browse'
  // idle_clip = "play one random idle clip from the configured pool". Folds
  // idle-motion-layer's interject scheduling into the unified wander scheduler
  // — wander and idle clip are both "the avatar is filling time" idle
  // behaviours; routing them through one timer keeps them mutex by design.
  | 'idle_clip';

/** Adapter the scheduler calls to actually drive the avatar. */
export interface WanderExecutor {
  /** Current pose label — 'neutral' means idle and eligible to wander. */
  getCurrentPose(): string;
  /** Returns true when the avatar subsystem is up (ready to accept calls). */
  isAvatarActive(): boolean;
  /**
   * Intersection of the given footprint with currently-active discrete
   * animation channels. Empty set ⇒ every channel is free and the intent
   * may proceed; a non-empty set names the specific conflicts the
   * scheduler should log and retreat from. Delegates through AvatarService
   * to the compiler's Tier A/B occupancy.
   */
  checkAvailable(footprint: Iterable<string>): Set<string>;
  walkForward(meters: number): Promise<void>;
  strafe(meters: number): Promise<void>;
  turn(radians: number): Promise<void>;
  setGazeTarget(target: GazeTarget | null): void;
  setHeadLook(target: HeadLookTarget | null): void;
  /**
   * Enqueue a clip-kind action through the discrete animation pipeline.
   * Fire-and-forget — the underlying `enqueueAutonomous` call returns
   * immediately and the clip plays out asynchronously. The next wander tick
   * (10-20s later by default) will see the clip in `activeAnimations` and
   * either drop a conflicting intent or pick something compatible.
   */
  playIdleClip(actionName: string): void;
}
