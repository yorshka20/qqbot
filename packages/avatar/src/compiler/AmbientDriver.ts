import type { BotState } from '../state/types';

/** Per-channel sinusoidal configuration. */
export interface ChannelOscillator {
  /** Peak amplitude (±value). Channel value oscillates in [center - amp, center + amp]. */
  amplitude: number;
  /** Full period in seconds. */
  periodSec: number;
  /** Initial phase offset in radians. Defaults to 0. */
  phase?: number;
  /** Center value (DC offset). Defaults to 0. */
  center?: number;
}

/**
 * A continuous driver that contributes values each compiler tick.
 *
 * Unlike discrete StateNode-based actions (which have an ADSR envelope and
 * finish), drivers run perpetually while registered. Their per-channel
 * contribution is additively mixed with action contributions every tick.
 *
 * `gate(state)` returns a global 0..1 multiplier applied to all of this
 * driver's channels for the given BotState — letting ambient calm down during
 * thinking / speaking. Return 1.0 for full amplitude; 0.0 disables this
 * driver in that state.
 */
export interface AmbientDriver {
  /** Stable identifier for registry lookup / unregister. */
  readonly id: string;
  /** Per-channel oscillator config. Keys are semantic channels (e.g. 'head.yaw'). */
  readonly channels: Record<string, ChannelOscillator>;
  /** 0..1 global intensity gate keyed on current BotState. Default: () => 1. */
  gate?(state: BotState): number;
}

/** Compute the current value a driver contributes for the given channel. */
export function sampleDriver(
  driver: AmbientDriver,
  channel: string,
  nowMs: number,
  state: BotState,
): number | undefined {
  const osc = driver.channels[channel];
  if (!osc) return undefined;
  const gateValue = driver.gate ? driver.gate(state) : 1;
  if (gateValue === 0) return undefined;
  const phase = osc.phase ?? 0;
  const center = osc.center ?? 0;
  const omega = (2 * Math.PI) / osc.periodSec;
  const t = nowMs / 1000;
  return center + osc.amplitude * gateValue * Math.sin(omega * t + phase);
}
