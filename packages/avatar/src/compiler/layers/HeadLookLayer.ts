import type { AvatarActivity } from '../../state/types';
import { BaseLayer } from './BaseLayer';

/**
 * Head-look override target. Values are degrees on the Cubism head-rotation
 * channels — `yaw` (left/right, ParamAngleX), `pitch` (up/down, ParamAngleY).
 * Omitted axes stay at the current drift position (so you can override yaw
 * without disturbing an existing pitch offset, e.g. nodding while looking
 * left).
 *
 * `null` clears the override; the layer drifts back to (0, 0) and then
 * emits nothing so discrete head actions (nod / shake_head) own the
 * channel cleanly.
 */
export interface HeadLookTarget {
  /** Degrees, clamped to the head.yaw channel range [-30, 30]. */
  yaw?: number;
  /** Degrees, clamped to the head.pitch channel range [-30, 30]. */
  pitch?: number;
}

/**
 * Sustained "look there with your head" override — additive contribution on
 * top of whatever the ambient stack (PerlinNoiseLayer, idle clips) and the
 * envelope pipeline (nod / shake_head / LLM `[H:]` tags in the future) are
 * writing. Stacking is deliberate: a shake_head while looking left should
 * read as "no" shaken around the look offset, not teleport the head back
 * to centre.
 *
 * Design mirrors {@link EyeGazeLayer}'s override path — target values drive
 * an Ornstein-Uhlenbeck integrator with a higher theta so the head reaches
 * its target in ~250–400 ms (slightly slower than the eyes, matching the
 * perceived mass of a real head follow). When the override is cleared, the
 * layer drifts back to (0, 0) and then goes silent — no active output
 * means no additive bias, so discrete head animations (nod / shake)
 * operate cleanly on their own.
 *
 * Channels:
 *   - `head.yaw`   (Cubism ParamAngleX on the renderer side, degrees)
 *   - `head.pitch` (Cubism ParamAngleY, degrees)
 *
 * Not `scalarIsAbsolute`: output **adds** to other contributors. The
 * channel's [-30, 30] clamp on the renderer side keeps stacked extremes
 * in a sane range.
 */
interface HeadLookConfig {
  /** OU mean-reversion strength per 60fps frame while override is active. Default 0.15
   *  ≈ 250 ms to 98 % convergence — about 60 % slower than the eye (0.25) to match the
   *  perceived mass difference between eye and head. */
  overrideTheta: number;
  /** OU mean-reversion strength per frame while the override is cleared (drifts back to
   *  zero). Slightly lower than overrideTheta so settling back reads as "relaxing" rather
   *  than "snapping back to attention". */
  restTheta: number;
  /** Channel clamp (degrees). Matches the `head.yaw` / `head.pitch` registry range. */
  maxDeg: number;
  /** Absolute magnitude at which the layer considers itself "at rest" and stops
   *  emitting, letting discrete envelope actions own the channel without additive
   *  interference. Degrees. */
  restThresholdDeg: number;
}

const DEFAULT_HEAD_LOOK_CONFIG: HeadLookConfig = {
  overrideTheta: 0.15,
  restTheta: 0.12,
  maxDeg: 30,
  restThresholdDeg: 0.1,
};

export class HeadLookLayer extends BaseLayer {
  readonly id = 'head-look';
  // Channel registry defines head.yaw / head.pitch for both model kinds; Cubism uses
  // ParamAngleX/Y, VRM maps to head bone Y/X rotation via the renderer's channel map.
  readonly modelSupport = ['cubism', 'vrm'] as const;

  private readonly config: HeadLookConfig;
  private target: HeadLookTarget | null = null;
  private currentYaw = 0;
  private currentPitch = 0;
  private lastSampleAt = 0;

  constructor(config: Partial<HeadLookConfig> = {}) {
    super();
    this.config = { ...DEFAULT_HEAD_LOOK_CONFIG, ...config };
  }

  override reset(): void {
    this.target = null;
    this.currentYaw = 0;
    this.currentPitch = 0;
    this.lastSampleAt = 0;
  }

  /**
   * Set a sustained head-look pose. Pass `null` to clear — the layer then drifts back to
   * (0, 0) and, once within `restThresholdDeg`, stops emitting so discrete head actions
   * (nod / shake_head / LLM tags) own the channel.
   *
   * Target values are clamped to `[-maxDeg, maxDeg]` at set-time, so downstream never
   * receives out-of-range inputs even if a caller passes 500°.
   */
  setHeadLook(target: HeadLookTarget | null): void {
    if (target === null) {
      this.target = null;
      return;
    }
    const clamp = (v: number): number => Math.max(-this.config.maxDeg, Math.min(this.config.maxDeg, v));
    this.target = {
      yaw: target.yaw !== undefined ? clamp(target.yaw) : undefined,
      pitch: target.pitch !== undefined ? clamp(target.pitch) : undefined,
    };
  }

  sample(nowMs: number, _activity: AvatarActivity): Record<string, number> {
    void _activity;

    // dt handling matches EyeGazeLayer: clamped to 100 ms for pause/resume resilience.
    const rawDt = this.lastSampleAt === 0 ? 16.67 : nowMs - this.lastSampleAt;
    const dt = Math.min(rawDt, 100);
    this.lastSampleAt = nowMs;

    // Decide per-axis target + theta. Target-absent axes drift to 0 (rest). Target
    // present → drift to target with overrideTheta. This lets a caller override yaw
    // alone (pitch stays free to respond to other bias sources) without awkward
    // "hold my pitch at 0 too" semantics.
    const resolveAxis = (current: number, t?: number): { target: number; theta: number } => {
      if (this.target === null || t === undefined) {
        return { target: 0, theta: this.config.restTheta };
      }
      return { target: t, theta: this.config.overrideTheta };
    };

    const yAxis = resolveAxis(this.currentYaw, this.target?.yaw);
    const pAxis = resolveAxis(this.currentPitch, this.target?.pitch);

    this.currentYaw += yAxis.theta * (dt / 16.67) * (yAxis.target - this.currentYaw);
    this.currentPitch += pAxis.theta * (dt / 16.67) * (pAxis.target - this.currentPitch);

    // Rest-silence: when no override is set AND we've drifted close enough to zero,
    // emit nothing so discrete nod / shake_head animations don't stack against a
    // tiny residual bias. This is the key difference from a pure-additive layer —
    // we avoid writing when we have nothing meaningful to contribute.
    if (
      this.target === null &&
      Math.abs(this.currentYaw) < this.config.restThresholdDeg &&
      Math.abs(this.currentPitch) < this.config.restThresholdDeg
    ) {
      this.currentYaw = 0;
      this.currentPitch = 0;
      return {};
    }

    const out: Record<string, number> = {};
    // Emit only axes that carry a meaningful value so the layer doesn't pin yaw=0 when
    // the caller only wants a pitch override. Matches the "null clears that axis"
    // semantic of the target object.
    if (Math.abs(this.currentYaw) >= this.config.restThresholdDeg || this.target?.yaw !== undefined) {
      out['head.yaw'] = this.currentYaw;
    }
    if (Math.abs(this.currentPitch) >= this.config.restThresholdDeg || this.target?.pitch !== undefined) {
      out['head.pitch'] = this.currentPitch;
    }
    return out;
  }
}
