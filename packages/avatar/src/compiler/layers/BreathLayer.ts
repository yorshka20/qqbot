import type { AvatarActivity } from '../../state/types';
import { BaseLayer } from './BaseLayer';

/** Per-channel multi-harmonic oscillator config. */
interface ChannelOsc {
  /** Peak amplitude of the fundamental harmonic, in the channel's natural unit. */
  amplitude: number;
  /** Period of the fundamental harmonic, seconds. */
  periodSec: number;
  /** Initial phase offset of the fundamental (radians). */
  phase?: number;
  /** DC offset. Defaults to 0. */
  center?: number;
  /**
   * Extra harmonics layered on top of the fundamental. Each entry scales
   * `periodSec` by `periodMul` (>1 = slower, <1 = faster) and scales
   * `amplitude` by `ampRatio`. Three harmonics with irrational ratios is
   * enough to break up the "pure sine" feel without straying far from
   * baseline breath motion.
   */
  harmonics?: { periodMul: number; ampRatio: number; phase: number }[];
}

/**
 * Baseline breathing / passive body motion layer.
 *
 * Mirrors Cubism's built-in `CubismBreath` targets (ParamAngle*, ParamBodyAngleX,
 * ParamBreath) but with a few additions to fight the "pure sinusoid" feel:
 *
 * - **Multi-harmonic sum per channel.** Each channel sums a fundamental plus 2
 *   slower/faster harmonics with different phases. Because the harmonic period
 *   ratios are irrational (1.7×, 2.3×), the combined waveform doesn't visibly
 *   repeat over any short interval — the motion reads as "natural drift"
 *   rather than a clock ticking.
 *
 * - **Extra `breath` channel.** Drives Cubism's `ParamBreath` (chest-rise on
 *   the model), which was missing from the previous driver. This is the
 *   single biggest "is the character alive?" signal for Live2D models.
 *
 * - **More channels.** Adds `body.y` in addition to `body.x` (subtle up/down
 *   body sway paired with breath), still in the VTS-normalized domain.
 *
 * Per-channel amplitudes are sized to match Cubism default breath (±15° head
 * yaw, ±8° pitch, etc.), so this layer on its own produces comparable ambient
 * motion to Cubism's built-in breath with the lights off.
 */
export class BreathLayer extends BaseLayer {
  readonly id = 'breath';
  // BreathLayer drives Cubism-specific breath params (ParamAngle*, ParamBreath).
  readonly modelSupport = ['cubism'] as const;

  /**
   * Runtime frequency multiplier applied to all oscillator channels.
   * Clamped to [0.2, 3.0]; default is 1.0 (identity).
   */
  private _rate = 1.0;

  /**
   * Change the ambient breathing frequency without touching config or tunables.
   *
   * `multiplier` is clamped to **[0.2, 3.0]**: values below 0.2 are silently
   * raised to 0.2; values above 3.0 are silently lowered to 3.0.
   *
   * - `setRate(1.0)` is identity — behaviour is identical to never calling it.
   * - `setRate(2.0)` doubles temporal frequency (halves effective period).
   * - `setRate(0.5)` halves temporal frequency (doubles effective period).
   *
   * Only temporal frequency changes; per-channel amplitudes and DC offsets are
   * not affected.
   */
  setRate(multiplier: number): void {
    if (Number.isNaN(multiplier)) return; // NaN: keep current rate unchanged
    this._rate = Math.min(3.0, Math.max(0.2, multiplier));
  }

  private readonly channels: Record<string, ChannelOsc> = {
    // Head rotation — degrees. Amplitudes match Cubism's default breath config;
    // Fundamental periods differ (+ prime-ish harmonics) so head motion doesn't
    // visibly loop.
    'head.yaw': {
      amplitude: 15,
      periodSec: 6.5,
      phase: 0,
      harmonics: [
        { periodMul: 1.7, ampRatio: 0.25, phase: 1.3 },
        { periodMul: 2.3, ampRatio: 0.15, phase: 2.1 },
      ],
    },
    'head.pitch': {
      amplitude: 8,
      periodSec: 3.5,
      phase: Math.PI / 3,
      harmonics: [
        { periodMul: 1.9, ampRatio: 0.3, phase: 0.7 },
        { periodMul: 3.1, ampRatio: 0.12, phase: 1.9 },
      ],
    },
    'head.roll': {
      amplitude: 10,
      periodSec: 5.5,
      phase: Math.PI / 2,
      harmonics: [
        { periodMul: 2.1, ampRatio: 0.22, phase: 0.4 },
        { periodMul: 2.7, ampRatio: 0.1, phase: 2.8 },
      ],
    },
    // Body offset — normalized [-1, 1]. Small amplitudes: the channel-map
    // scales ×30 on the Cubism side, so 0.13 → ~3.9° body angle.
    'body.x': {
      amplitude: 0.13,
      periodSec: 15.5,
      phase: 0,
      harmonics: [{ periodMul: 1.6, ampRatio: 0.35, phase: 1.1 }],
    },
    'body.y': {
      amplitude: 0.08,
      periodSec: 4.2,
      phase: Math.PI / 4,
      harmonics: [{ periodMul: 1.8, ampRatio: 0.4, phase: 0.9 }],
    },
    // Breath — Cubism ParamBreath is conventionally [0, 1] with larger values
    // meaning "inhaled". We oscillate center=0.5, amplitude=0.5, so value
    // spans [0, 1] with a ~3.5s cycle — matches Cubism default breath period.
    breath: { amplitude: 0.5, periodSec: 3.5, phase: 0, center: 0.5 },
  };

  sample(nowMs: number, _activity: AvatarActivity): Record<string, number> {
    void _activity;
    const t = nowMs / 1000;
    const out: Record<string, number> = {};
    for (const [ch, osc] of Object.entries(this.channels)) {
      out[ch] = this.computeChannel(osc, t);
    }
    return out;
  }

  private computeChannel(osc: ChannelOsc, t: number): number {
    const center = osc.center ?? 0;
    const phase = osc.phase ?? 0;
    // Multiply angular frequency by _rate: higher rate → faster oscillation.
    const omega = ((2 * Math.PI) / osc.periodSec) * this._rate;
    let v = osc.amplitude * Math.sin(omega * t + phase);
    if (osc.harmonics) {
      for (const h of osc.harmonics) {
        const omegaH = omega / h.periodMul;
        v += osc.amplitude * h.ampRatio * Math.sin(omegaH * t + h.phase);
      }
    }
    return center + v;
  }
}
