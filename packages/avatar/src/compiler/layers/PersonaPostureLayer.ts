import type { AvatarActivity } from '../../state/types';
import { BaseLayer } from './BaseLayer';
import type { GazeDistribution } from './EyeGazeLayer';

// ---------------------------------------------------------------------------
// Constants — maximum additive radian offsets and smoothing time constant.
// Tune these to taste; keeping them here makes per-channel behaviour auditable
// without hunting through the implementation.
// ---------------------------------------------------------------------------

/** Maximum additive radian offset on vrm.spine.x (forward/backward lean). */
const MAX_LEAN_SPINE_RAD = 0.2;

/** vrm.chest.x offset = postureLean * MAX_LEAN_SPINE_RAD * CHEST_ASSIST_RATIO.
 *  A smaller secondary assist so the lean reads as a whole-torso pose, not
 *  just a single joint tilt. */
const CHEST_ASSIST_RATIO = 0.4;

/** Maximum additive radian offset on vrm.head.z (left/right head tilt). */
const MAX_HEAD_TILT_RAD = 0.15;

/** First-order exponential smoothing time constant in ms.
 *  tau ≈ 1200ms means ~63% of a bias change is reached in 1.2s, and ~95% in ~3.6s.
 *  This produces a gradual, perceptible posture drift that reads as personality
 *  rather than a mechanical snap — aligns with the ticket's "roughly 1-2 s" target. */
const SMOOTHING_TAU_MS = 1200;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Bias parameters accepted by {@link PersonaPostureLayer.setBias}.
 *
 * All fields are optional — omitting a field leaves that dimension's bias
 * unchanged. An empty call (`setBias({})`) is always a no-op.
 */
export interface PersonaPostureBias {
  /**
   * Additive forward/backward lean in normalised [-1, 1].
   * Positive = lean forward; negative = lean back.
   * Maps to `vrm.spine.x` (full amplitude) and `vrm.chest.x` (partial assist).
   */
  postureLean?: number;

  /**
   * Additive head tilt in normalised [-1, 1].
   * Positive = tilt right; negative = tilt left.
   * Maps to `vrm.head.z`.
   */
  headTiltBias?: number;

  /**
   * Default gaze contact preference in [0, 1].
   * Only affects the eye-gaze layer's no-override path.
   * `1` = biased toward camera-center; `0` = avoidant/downward default.
   * Pass `null` to clear (restores original OU behaviour).
   * Has no effect if no EyeGazeLayer was wired via {@link setEyeGazeLayer}.
   */
  gazeContactPreference?: number | null;

  /**
   * Probability distribution over saccade target kinds. Takes precedence over
   * gazeContactPreference if both are present in the same setBias call.
   * Has no effect if no EyeGazeLayer was wired via {@link setEyeGazeLayer}.
   */
  gazeDistribution?: GazeDistribution | null;
}

// ---------------------------------------------------------------------------
// Narrow interface for the EyeGazeLayer coupling
// ---------------------------------------------------------------------------

/**
 * Narrow interface used by PersonaPostureLayer to drive the EyeGazeLayer
 * default-contact bias without importing a concrete class reference.
 */
export interface EyeGazeDefaultBias {
  /**
   * Set the default contact preference for the no-override gaze path.
   * `null` clears the preference and restores vanilla OU behaviour.
   */
  setDefaultContactPreference(pref: number | null): void;
  /**
   * Set a probability distribution over saccade target kinds.
   * `null` clears the distribution and restores vanilla OU behaviour.
   */
  setGazeDistribution(dist: GazeDistribution | null): void;
}

// ---------------------------------------------------------------------------
// PersonaPostureLayer
// ---------------------------------------------------------------------------

/**
 * VRM-only continuous layer that applies additive posture bias with
 * first-order exponential smoothing.
 *
 * ### Channels written
 * - `vrm.spine.x`   — forward/backward lean (driven by `postureLean`)
 * - `vrm.chest.x`   — partial assist for a more natural torso lean
 * - `vrm.head.z`    — left/right head tilt (driven by `headTiltBias`)
 *
 * ### activeChannels exclusion
 * Any channel in the `activeChannels` set passed to `sample()` is silently
 * dropped from the output so discrete action animations are never additively
 * corrupted.
 *
 * ### EyeGazeLayer coupling
 * Wire an EyeGazeLayer via {@link setEyeGazeLayer} so that calling
 * `setBias({ gazeContactPreference })` forwards to the gaze layer without
 * exposing EyeGazeLayer internals to the AvatarService public API.
 *
 * ### Layer id
 * `persona-posture` — used by AvatarService to look up and call `setBias()`.
 */
export class PersonaPostureLayer extends BaseLayer {
  readonly id = 'persona-posture';
  readonly modelSupport = ['vrm'] as const;

  // Smoothed bias state —target is set by setBias(); current approaches
  // target each tick via an exponential filter.
  private targetLean = 0;
  private currentLean = 0;
  private targetHeadTilt = 0;
  private currentHeadTilt = 0;
  private lastSampleAt = 0;

  // Optional reference to the EyeGazeLayer for gazeContactPreference routing.
  private eyeGazeBias: EyeGazeDefaultBias | null = null;

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  /**
   * Wire an EyeGazeLayer (or any object implementing {@link EyeGazeDefaultBias})
   * so that `setBias({ gazeContactPreference })` can drive the gaze layer's
   * default-contact bias path.
   *
   * Called once from `AnimationCompiler.registerContinuousStack()` during
   * compiler initialisation — not part of the runtime hot path.
   */
  setEyeGazeLayer(layer: EyeGazeDefaultBias): void {
    this.eyeGazeBias = layer;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Set the additive posture bias. All fields are optional; omitting a field
   * leaves that dimension unchanged. Calling `setBias({})` is always a no-op.
   *
   * Values are normalised:
   * - `postureLean` and `headTiltBias` are clamped to [-1, 1].
   * - `gazeContactPreference` is clamped to [0, 1], or `null` to clear.
   */
  setBias(bias: PersonaPostureBias): void {
    if (bias.postureLean !== undefined) {
      this.targetLean = Math.max(-1, Math.min(1, bias.postureLean));
    }
    if (bias.headTiltBias !== undefined) {
      this.targetHeadTilt = Math.max(-1, Math.min(1, bias.headTiltBias));
    }
    if ('gazeDistribution' in bias) {
      this.eyeGazeBias?.setGazeDistribution(bias.gazeDistribution ?? null);
    } else if ('gazeContactPreference' in bias) {
      const pref = bias.gazeContactPreference;
      if (pref === null || pref === undefined) {
        this.eyeGazeBias?.setDefaultContactPreference(null);
      } else {
        this.eyeGazeBias?.setDefaultContactPreference(Math.max(0, Math.min(1, pref)));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // BaseLayer overrides
  // ---------------------------------------------------------------------------

  override reset(): void {
    // Reset the smoothed current state and the timer only. targetLean and
    // targetHeadTilt are persona configuration set by setBias() — they survive
    // resets (including the LayerManager.register call) so the bias persists
    // across compiler reinitialisation. The smoothing will re-approach the
    // targets on the next sampling cycle.
    this.currentLean = 0;
    this.currentHeadTilt = 0;
    this.lastSampleAt = 0;
  }

  /**
   * Sample additive posture contributions for this tick.
   *
   * Applies a dt-clamped first-order exponential filter (tau = SMOOTHING_TAU_MS)
   * to approach the target bias values. Channels present in `activeChannels`
   * are excluded from the output to avoid colliding with discrete animations.
   */
  sample(nowMs: number, _activity: AvatarActivity, activeChannels?: ReadonlySet<string>): Record<string, number> {
    void _activity;

    // dt is clamped to 100ms to prevent a huge jump after a pause.
    const rawDt = this.lastSampleAt === 0 ? 16.67 : nowMs - this.lastSampleAt;
    const dt = Math.min(rawDt, 100);
    this.lastSampleAt = nowMs;

    // First-order exponential approach: alpha = 1 − e^(−dt/tau).
    // alpha → 1 as dt → ∞ (instantaneous jump after a long pause clamped above),
    // alpha → 0 as dt → 0 (no movement on zero-length ticks).
    const alpha = 1 - Math.exp(-dt / SMOOTHING_TAU_MS);
    this.currentLean += alpha * (this.targetLean - this.currentLean);
    this.currentHeadTilt += alpha * (this.targetHeadTilt - this.currentHeadTilt);

    const out: Record<string, number> = {};

    // vrm.spine.x — primary lean channel.
    const spineKey = 'vrm.spine.x';
    if (!(activeChannels?.has(spineKey) ?? false)) {
      const v = this.currentLean * MAX_LEAN_SPINE_RAD;
      if (v !== 0) out[spineKey] = v;
    }

    // vrm.chest.x — partial assist so the lean reads as whole-torso motion.
    const chestKey = 'vrm.chest.x';
    if (!(activeChannels?.has(chestKey) ?? false)) {
      const v = this.currentLean * MAX_LEAN_SPINE_RAD * CHEST_ASSIST_RATIO;
      if (v !== 0) out[chestKey] = v;
    }

    // vrm.head.z — head tilt.
    const headKey = 'vrm.head.z';
    if (!(activeChannels?.has(headKey) ?? false)) {
      const v = this.currentHeadTilt * MAX_HEAD_TILT_RAD;
      if (v !== 0) out[headKey] = v;
    }

    return out;
  }
}
