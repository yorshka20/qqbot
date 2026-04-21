import type { TunableParam } from '../../preview/types';
import type { AvatarActivity } from '../../state/types';

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
   * `activity` is the current runtime activity ({ ambientGain, pose }). Most
   * layers ignore it — the LayerManager already multiplies each layer's
   * output by `activity.ambientGain` — but layers whose behavior should
   * change with pose (e.g. IdleMotionLayer gating on truly-idle) read it
   * here. Layers must be cheap: called every compiler tick.
   *
   * `activeChannels` is the set of channel ids that active discrete
   * animations will write this tick. Layers holding absolute (A-pose) values
   * (e.g. VRM idle clips) MUST skip channels in this set to avoid additive
   * collision with the action's target. Layers holding delta-style
   * contributions around 0 (e.g. breath, gaze wander) can ignore it.
   */
  sample(
    nowMs: number,
    activity: AvatarActivity,
    activeChannels?: ReadonlySet<string>,
  ): Record<string, number>;

  /**
   * Optional: sample quaternion tracks. Called in the same tick as
   * `sample()`. Keys are base bone channels (e.g. `vrm.rightLowerArm`);
   * values are unit quaternions. The compiler emits four scalar output
   * channels `vrm.<bone>.q[xyzw]` per quat contribution via
   * slerp-with-identity, bypassing spring-damper and channelBaseline — see
   * `AnimationCompiler.tick` quat-path for the full contract.
   *
   * Unlike `sample()`, quat output is NOT multiplied by the layer's weight
   * or the activity's `ambientGain`: absolute-pose values do not dim
   * meaningfully, and a half-intensity quaternion is not a half-intensity
   * pose. A layer wanting to fade its quat contribution must do so by
   * slerp-toward-identity internally before returning.
   */
  sampleQuat?(
    nowMs: number,
    activity: AvatarActivity,
    activeChannels?: ReadonlySet<string>,
  ): Record<string, { x: number; y: number; z: number; w: number }>;

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

  /**
   * Optional: expose a set of runtime-tunable parameters for the tuning HUD.
   * Called on-demand when the HUD requests the current param list.
   */
  getTunableParams?(): TunableParam[];

  /**
   * Optional: set a single tunable by id. Must take effect immediately
   * (or by the next sample() at latest). Silently drop unknown paramIds.
   */
  setTunableParam?(paramId: string, value: number): void;
}
