/**
 * Wander intent picker + step execution.
 *
 * Pure functions over configured weights/amplitudes and a random source,
 * so tests can inject deterministic RNGs.
 */

import type { GazeTarget } from '@qqbot/avatar';
import type { WanderConfig } from '@/persona/types';
import type { WanderExecutor, WanderIntent, WanderIntentKind, WanderStep } from './types';

/**
 * Glance targets coupling gaze + head rotation. Head yaw is in degrees (Cubism
 * head.yaw / head.pitch channel units, clamped to ±30° by HeadLookLayer). Pitch
 * handles "up" which `turn()` couldn't express. Camera stays head-neutral; left/
 * right yaw to ±15° (half the channel range, reads as "glanced over there").
 *
 * The head offset is applied through `HeadLookLayer`, which rotates the head bone
 * only — the body stays put. Previously `glance` went through WalkingLayer.turn()
 * and rotated the whole root; that looked like the avatar was turning, not just
 * looking.
 */
const NAMED_GLANCE_TARGETS: Array<{ target: GazeTarget; headYawDeg: number; headPitchDeg: number }> = [
  { target: { type: 'named', name: 'camera' }, headYawDeg: 0, headPitchDeg: 0 },
  { target: { type: 'named', name: 'left' }, headYawDeg: -15, headPitchDeg: 0 },
  { target: { type: 'named', name: 'right' }, headYawDeg: 15, headPitchDeg: 0 },
  // Positive pitch = head up (matches the avatar looking toward +Y); mirrors the
  // named eye target 'up' which uses negative eye.ball.y (Cubism convention).
  { target: { type: 'named', name: 'up' }, headYawDeg: 0, headPitchDeg: -10 },
];

/**
 * Pick a wander intent using the configured weighted random over
 * intent kinds, then generate a concrete step sequence by sampling
 * amplitudes from the amplitude caps.
 *
 * `rng` defaults to `Math.random`; tests pass a deterministic source.
 */
export function pickIntent(config: WanderConfig, rng: () => number = Math.random): WanderIntent {
  const kind = pickKind(config.intents, rng);
  const steps = buildSteps(kind, config, rng);
  return { label: kind, steps };
}

function pickKind(weights: WanderConfig['intents'], rng: () => number): WanderIntentKind {
  const entries: Array<[WanderIntentKind, number]> = (
    Object.entries(weights) as Array<[WanderIntentKind, number]>
  ).filter(([, w]) => Number.isFinite(w) && w > 0);
  if (entries.length === 0) return 'glance';
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [kind, w] of entries) {
    r -= w;
    if (r <= 0) return kind;
  }
  return entries[entries.length - 1][0];
}

function buildSteps(kind: WanderIntentKind, config: WanderConfig, rng: () => number): WanderStep[] {
  const amp = config.amplitude;
  // [-1..1] sample centred on 0 (no trailing sign bias).
  const signed = (): number => rng() * 2 - 1;
  // [0.25..1] (never so tiny it disappears visually).
  const positive = (): number => 0.25 + rng() * 0.75;

  switch (kind) {
    case 'glance': {
      const pick = NAMED_GLANCE_TARGETS[Math.floor(rng() * NAMED_GLANCE_TARGETS.length)];
      const holdMs = 2500 + Math.floor(rng() * 1500);
      const needsHead = Math.abs(pick.headYawDeg) > 1e-3 || Math.abs(pick.headPitchDeg) > 1e-3;
      const steps: WanderStep[] = [];
      if (needsHead) {
        steps.push({ kind: 'setHead', target: { yaw: pick.headYawDeg, pitch: pick.headPitchDeg } });
      }
      steps.push({ kind: 'setGaze', target: pick.target }, { kind: 'wait', ms: holdMs });
      steps.push({ kind: 'setGaze', target: { type: 'clear' } });
      if (needsHead) steps.push({ kind: 'setHead', target: null });
      return steps;
    }
    case 'look_around': {
      // Head-only look-around (body stays put). Yaw is sampled in degrees on the head
      // channel's ±30° range; maxTurnRad's value is kept as a "relative amplitude cap"
      // so tuning maxTurnRad smaller still produces a proportionally smaller look-around.
      // Factor 15°/radian (so default maxTurnRad=π/6 ≈ 0.524 rad → ~7.85° peak, doubled
      // by positive() up to ~16° which fits comfortably inside the ±30° head channel).
      const degPerRad = 30; // scales rad amplitude into reasonable head-yaw degrees
      const y1 = signed() * amp.maxTurnRad * positive() * degPerRad;
      const y2 = -y1 * (0.5 + rng() * 0.5);
      return [
        { kind: 'setHead', target: { yaw: y1 } },
        { kind: 'wait', ms: 500 + Math.floor(rng() * 900) },
        { kind: 'setHead', target: { yaw: y2 } },
        { kind: 'wait', ms: 400 + Math.floor(rng() * 600) },
        { kind: 'setHead', target: null },
      ];
    }
    case 'shift_weight': {
      const m = signed() * amp.maxStrafeMeters * positive();
      return [
        { kind: 'strafe', meters: m },
        { kind: 'wait', ms: 1200 + Math.floor(rng() * 1600) },
        { kind: 'strafe', meters: -m },
      ];
    }
    case 'micro_step': {
      const m = signed() * amp.maxStepMeters * positive();
      return [
        { kind: 'walkForward', meters: m },
        { kind: 'wait', ms: 1500 + Math.floor(rng() * 1800) },
        { kind: 'walkForward', meters: -m },
      ];
    }
    case 'browse': {
      const t = signed() * amp.maxTurnRad * positive();
      const m = positive() * amp.maxStepMeters;
      return [
        { kind: 'turn', radians: t },
        { kind: 'walkForward', meters: m },
        { kind: 'wait', ms: 600 + Math.floor(rng() * 1000) },
        { kind: 'walkForward', meters: -m },
        { kind: 'turn', radians: -t },
      ];
    }
    case 'idle_clip': {
      // Pool of clip-kind action names declared in config; the action map's
      // own variant random-pick handles per-clip selection within a pool
      // action like `vrm_idle_loop` (14 variants).
      const pool = config.idleClipPool;
      if (!pool || pool.length === 0) {
        // No pool configured — degenerate to a no-op wait so the scheduler
        // round still completes (better than throwing).
        return [{ kind: 'wait', ms: 100 }];
      }
      const actionName = pool[Math.floor(rng() * pool.length)];
      return [{ kind: 'playIdleClip', actionName }];
    }
  }
}

/**
 * Static channel footprint per step kind. Used by the scheduler to gate
 * on Tier A/B occupancy so wander never walks / turns while a discrete
 * action is driving the same body segments. Conservative on purpose:
 *
 * - Walk-cycle steps claim the VRM root + the bone set the walk-cycle clip
 *   overlays (legs, spine, hips). WalkingLayer itself writes root via the
 *   scalarBypass path and the cycle clip writes the rest via quat —
 *   discrete actions that touch any of these (`greet`, `bow`, etc.) would
 *   collide.
 * - Gaze / head overrides claim the eye-ball and head-rotation channels
 *   so an action with explicit head.* / eye.ball.* targets isn't stomped
 *   mid-motion.
 * - `wait` has empty footprint — it's just a sleep and never conflicts.
 *
 * Wander only drives VRM roots and channels available across kinds; the
 * bot-side footprint stays in semantic channel names so it matches actions
 * authored against either model (VRM actions use `vrm.*` directly, Cubism
 * actions use aliased `head.*` / `eye.*`).
 */
const WALK_FOOTPRINT: ReadonlySet<string> = new Set([
  'vrm.root.x',
  'vrm.root.z',
  'vrm.root.rotY',
  'vrm.hips',
  'vrm.spine',
  'vrm.leftUpperLeg',
  'vrm.rightUpperLeg',
  'vrm.leftLowerLeg',
  'vrm.rightLowerLeg',
  'vrm.leftFoot',
  'vrm.rightFoot',
]);

const GAZE_FOOTPRINT: ReadonlySet<string> = new Set(['eye.ball.x', 'eye.ball.y']);

const HEAD_FOOTPRINT: ReadonlySet<string> = new Set(['head.yaw', 'head.pitch', 'head.roll', 'vrm.head']);

function stepFootprint(step: WanderStep): ReadonlySet<string> {
  switch (step.kind) {
    case 'turn':
    case 'walkForward':
    case 'strafe':
      return WALK_FOOTPRINT;
    case 'setGaze':
      return GAZE_FOOTPRINT;
    case 'setHead':
      return HEAD_FOOTPRINT;
    case 'playIdleClip':
      // Empty: the discrete enqueue path runs its own cross-action conflict
      // check (which deliberately excludes continuous-layer ownership so the
      // basic idle layer's leg/spine claim doesn't self-block an idle clip
      // interject). Letting the scheduler-level footprint say "free" is
      // intentional — playIdleClip never collides with itself by design.
      return EMPTY_FOOTPRINT;
    case 'wait':
      return EMPTY_FOOTPRINT;
  }
}

const EMPTY_FOOTPRINT: ReadonlySet<string> = new Set();

/**
 * Union of channel footprints across every step in an intent. Called once
 * by the scheduler after `pickIntent`, before executing — the scheduler
 * drops the whole tick if any channel in the union collides with active
 * animations. Returns empty for wait-only intents (never conflicts).
 */
export function getIntentFootprint(intent: WanderIntent): ReadonlySet<string> {
  const out = new Set<string>();
  for (const step of intent.steps) {
    for (const ch of stepFootprint(step)) out.add(ch);
  }
  return out;
}

/**
 * Execute a sequence of wander steps. Each step's promise is awaited;
 * WalkInterruptedError (and any other motion rejection) is swallowed so
 * one interrupted step does not abort the rest of the sequence *visibly*
 * — the caller is expected to have already gated start-conditions.
 *
 * The `sleep` adapter is injectable for tests.
 */
export async function executeIntent(
  intent: WanderIntent,
  executor: WanderExecutor,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  for (const step of intent.steps) {
    try {
      await runStep(step, executor, sleep);
    } catch {
      // Absorb motion rejection (e.g. WalkInterruptedError when an LLM
      // command preempts us); continue to the next step so `wait`/gaze
      // cleanup still happens.
    }
  }
}

async function runStep(
  step: WanderStep,
  executor: WanderExecutor,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  switch (step.kind) {
    case 'turn':
      await executor.turn(step.radians);
      return;
    case 'walkForward':
      await executor.walkForward(step.meters);
      return;
    case 'strafe':
      await executor.strafe(step.meters);
      return;
    case 'setGaze':
      executor.setGazeTarget(step.target);
      return;
    case 'setHead':
      executor.setHeadLook(step.target);
      return;
    case 'playIdleClip':
      executor.playIdleClip(step.actionName);
      return;
    case 'wait':
      await sleep(step.ms);
      return;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
