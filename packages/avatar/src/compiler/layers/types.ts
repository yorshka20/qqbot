import type { BotState } from '../../state/types';

/**
 * Continuous, independently-ticking animation source that contributes
 * per-channel values every compiler tick.
 *
 * Layers are orthogonal to discrete action animations (`StateNode` with ADSR
 * envelope). Multiple layers run in parallel and their per-channel outputs
 * are additively mixed with action contributions by `AnimationCompiler.tick`.
 *
 * Conceptually each layer is its own loop — a `BreathLayer` oscillates head
 * params, an `AutoBlinkLayer` drives the eye-open state machine, an
 * `EyeGazeLayer` wanders the gaze, an `IdleMotionLayer` plays random clips.
 * They know nothing about each other; the compiler does the blending.
 */
export interface AnimationLayer {
  /** Stable identifier for registry lookup / unregister / debug. */
  readonly id: string;

  /**
   * Sample the layer at wall-clock time `nowMs`. Returns a partial channel map
   * — channels absent from the return value contribute nothing this tick.
   *
   * `state` is the current BotState so layers that care (most do) can gate or
   * modulate themselves. Layers must be cheap: called every compiler tick.
   */
  sample(nowMs: number, state: BotState): Record<string, number>;

  /**
   * Enable / disable the layer at runtime. A disabled layer returns `{}` from
   * `sample()`. Defaults to enabled on construction.
   */
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;

  /**
   * Global blend weight for this layer's contributions. The LayerManager
   * multiplies every channel value this layer returns by `weight` before
   * handing them to the compiler. Defaults to 1.0.
   *
   * Reserved for future per-layer mixing control (e.g. crossfading BreathLayer
   * down while IdleMotionLayer plays a bigger motion). Not currently tuned —
   * callers can leave it at the default.
   */
  getWeight(): number;
  setWeight(weight: number): void;

  /** Reset any internal state (phase, timers, RNG seeds). Called on layer register or explicit reset. */
  reset?(): void;
}

/**
 * 0..1 gate multiplier applied to every layer's contribution, keyed by bot
 * state. Lets ambient motion calm down during thinking/speaking etc. without
 * each layer re-implementing the policy.
 *
 * Returning 0 effectively silences all layers in that state. Layers that need
 * to behave differently (e.g. EyeGazeLayer should keep running during speaking)
 * should apply their own internal modulation inside `sample()` too.
 */
export type LayerGate = (state: BotState) => number;

/** Default gate: calm during concentration states, full during idle. */
export const DEFAULT_LAYER_GATE: LayerGate = (state) => {
  switch (state) {
    case 'idle':
      return 1.0;
    case 'listening':
      return 0.8;
    case 'thinking':
      return 0.5;
    case 'speaking':
      return 0.3;
    case 'reacting':
      return 0.4;
    default:
      return 1.0;
  }
};
