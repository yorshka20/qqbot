/**
 * Easing function type identifiers for animation curves.
 * Each easing type defines how intermediate animation values are calculated
 * over the course of an animation phase.
 */
export type EasingType = 'linear' | 'easeInOutCubic' | 'easeOutElastic' | 'easeInOutQuad' | 'easeOutBounce';

/**
 * Phase of an animation within its lifecycle.
 * - attack: ramping up to full intensity
 * - sustain: holding at peak intensity
 * - release: ramping down to neutral
 */
export type AnimationPhase = 'attack' | 'sustain' | 'release';

/**
 * A single keyframe-like node that defines a target state
 * for the avatar at a given timestamp.
 */
export interface StateNode {
  /** Name of the action (e.g., 'smile', 'nod', 'wave') */
  action: string;
  /** Emotional state this node targets */
  emotion: string;
  /** Intensity multiplier for parameter values (0.0–1.0) */
  intensity: number;
  /** Time in milliseconds when this node becomes active */
  timestamp: number;
  /** How long this node holds its state in ms */
  duration: number;
  /** Optional delay before this node starts */
  delay?: number;
  /** Easing function used for interpolation */
  easing: EasingType;
}

/**
 * A parameter target with a weighted influence.
 * Used to build blended animation states.
 *
 * `channel` is a semantic, renderer-agnostic identifier (e.g. "head.yaw",
 * "mouth.smile", "eye.open.left"). Driver adapters translate channels to
 * their renderer's native parameter IDs (VTS tracking params / Cubism
 * Live2D params / WebGPU shader uniforms).
 */
export interface ParamTarget {
  /** Semantic channel identifier (e.g. "head.yaw", "mouth.smile"). */
  channel: string;
  /** Target value to interpolate toward, in the channel's natural range */
  targetValue: number;
  /** Blend weight for this parameter (0.0–1.0) */
  weight: number;
  /**
   * Optional oscillation cycle count across the animation duration. When set,
   * the per-tick contribution is multiplied by `sin(2π * oscillate * rawProgress)`
   * on top of the ADSR envelope — used for actions that are semantically periodic
   * (shake_head, nod, wave) rather than a one-shot pose. `targetValue` then
   * represents the **peak amplitude** of the oscillation. Integer or half-integer
   * values end the cycle at zero crossing (no final jump).
   */
  oscillate?: number;
  /**
   * Time offset for this target's envelope start, relative to anim.startTime.
   * Negative = target starts EARLIER than the animation (anticipation /
   * secondary motion). Positive = starts later. Only affects target-local
   * envelope timing; does NOT change anim.startTime or anim.endTime.
   * Clamped silently to [-1000, +1000] ms at resolve time.
   */
  leadMs?: number;
  /**
   * Time offset for this target's envelope end, relative to anim.endTime.
   * Negative = target finishes before the animation ends; positive = lingers
   * afterward. Clamped silently to [-1000, +1000] ms at resolve time.
   */
  lagMs?: number;
}

/**
 * An actively playing animation instance.
 * Tracks the runtime state of an animation as it progresses.
 */
export interface ActiveAnimation {
  /** The source state node for this animation */
  node: StateNode;
  /** Wall-clock time when this animation started (ms) */
  startTime: number;
  /** Wall-clock time when this animation ends (ms) */
  endTime: number;
  /** Array of parameter targets with weights */
  targetParams: ParamTarget[];
  /** Current lifecycle phase of this animation */
  phase: AnimationPhase;
  /**
   * Optional end-pose to crossfade into once the main animation completes.
   * Populated from `ResolvedAction.endPose` when the action map entry has one.
   */
  endPose?: ActionEndPoseEntry[];
  /**
   * Wall-clock time (ms) at which the fade-out crossfade should begin.
   * Set by the compiler when transitioning from the sustain to release phase
   * with an active end pose.
   */
  fadeOutStartMs?: number;
}

/**
 * Output frame data containing computed parameter values
 * at a specific timestamp.
 */
export interface FrameOutput {
  /** Timestamp this frame represents (ms) */
  timestamp: number;
  /** Map of parameter IDs to their computed values */
  params: Record<string, number>;
}

/**
 * A single channel entry describing the resting/end pose value after
 * an action completes its main motion. Used by the crossfade system to
 * smoothly settle the avatar into a held pose instead of snapping back
 * to neutral at animation end.
 */
export interface ActionEndPoseEntry {
  /** Semantic channel identifier (e.g. "arm.right", "body.x"). */
  channel: string;
  /**
   * Target value for this channel in the end pose. Unlike the main
   * `params[].targetValue`, this value is NOT scaled by intensity —
   * it represents an absolute visual settling point.
   */
  value: number;
  /** Optional blend weight for this channel in the end pose (0.0–1.0). */
  weight?: number;
}

/**
 * The resolved output of `ActionMap.resolveAction()`.
 * Bundles the scaled per-frame targets together with the optional end-pose
 * and hold duration so callers can drive both the main animation and the
 * subsequent crossfade in one return value.
 */
export interface ResolvedAction {
  /** Scaled parameter targets for the main animation phase. */
  targets: ParamTarget[];
  /**
   * Optional end-pose entries to crossfade into after the main animation
   * completes. Values are NOT scaled by intensity.
   */
  endPose?: ActionEndPoseEntry[];
  /**
   * Optional duration in ms to hold the end pose before releasing back to
   * the baseline. Copied through from the action-map entry unchanged.
   */
  holdMs?: number;
}

/**
 * A single entry in the action map describing which parameters
 * are affected by a named action.
 */
export interface ActionMapEntry {
  /** List of parameters and their default target values + weights */
  params: ParamTarget[];
  /** Default duration for this action in milliseconds */
  defaultDuration: number;
  /**
   * Optional semantic category tag used by consumers (e.g. preview HUD) to
   * group actions visually. Convention: `'emotion' | 'movement' | 'micro'`,
   * but free-form — unknown values are grouped under a fallback bucket.
   */
  category?: string;
  /**
   * Optional one-line natural-language description of what the action
   * expresses. Injected into avatar prompt templates so the LLM knows when
   * to pick this action (e.g. `nod: 点头表示同意`). Short + specific —
   * prompt budget is tight and every action description ships in every
   * avatar reply.
   */
  description?: string;
  /**
   * Optional end-pose definition. When present, the compiler will crossfade
   * into this pose after the main animation completes instead of releasing
   * fully to neutral. Values are NOT scaled by intensity.
   */
  endPose?: ActionEndPoseEntry[];
  /**
   * Optional duration in ms to hold the end pose before crossfading back to
   * the baseline. Passed through to `ResolvedAction.holdMs` unchanged.
   */
  holdMs?: number;
  /**
   * Correlated secondary-motion targets that play alongside the main `params`.
   * Same shape as `params` (ParamTarget), authored separately for readability
   * and to express the "every time X happens, also nudge Y" semantic. Merged
   * with `params` at resolve time; participates in crossfade exactly like
   * primary targets. Does NOT appear in endPose.
   */
  accompaniment?: ParamTarget[];
}

/**
 * Public summary of a single action. Emitted by `ActionMap.listActions()` and
 * served over the PreviewServer `/action-map` endpoint so UIs can build their
 * trigger lists dynamically instead of hardcoding action names.
 */
export interface ActionSummary {
  /** Action name (dict key in action-map.json). */
  name: string;
  /** Default ADSR duration in milliseconds. */
  defaultDuration: number;
  /** Optional semantic category. See `ActionMapEntry.category`. */
  category?: string;
  /** Unique list of semantic channels this action writes (deduped). */
  channels: string[];
  /** Optional one-line description forwarded verbatim from `ActionMapEntry.description`. */
  description?: string;
}

/**
 * Spring-damper parameters for a single animation channel.
 */
export interface SpringParams {
  /** Natural frequency in rad/s. Higher = faster response. */
  omega: number;
  /** Damping ratio. 1 = critical (fastest no-overshoot); <1 under-damped (overshoot); >1 over-damped (slow). */
  zeta: number;
}

/**
 * Configuration for the animation compiler.
 * Controls frame timing, smoothing, and ADSR ratio defaults.
 */
export interface CompilerConfig {
  /** Source capture framerate (fps) */
  fps: number;
  /** Output render framerate (fps) */
  outputFps: number;
  /** Default easing when none specified on a node */
  defaultEasing: EasingType;
  /**
   * @deprecated since 2026-04-19. Replaced by spring-damper smoothing
   * (`springDefaults` / `springByChannel`). Value is ignored by
   * `AnimationCompiler.tick()`; kept only so existing config.jsonc
   * files with `smoothingFactor` still type-check.
   */
  smoothingFactor: number;
  /** Attack phase ratio of the ADSR envelope (0.0–1.0) */
  attackRatio: number;
  /** Release phase ratio of the ADSR envelope (0.0–1.0) */
  releaseRatio: number;
  /**
   * Enable the default continuous animation layer stack (breath, auto-blink,
   * eye gaze, idle motion). Each layer can be individually disabled via
   * `AnimationCompiler.getLayer(id).setEnabled(false)` at runtime.
   */
  layers?: {
    enabled: boolean;
  };
  /** Fallback spring params for channels not in `springByChannel`. */
  springDefaults?: SpringParams;
  /** Per-channel spring params. Overrides the built-in DEFAULT_SPRING_BY_CHANNEL table. */
  springByChannel?: Record<string, SpringParams>;
  /**
   * Duration in ms for the crossfade transition from main animation into the
   * end pose (and later from end pose back to baseline). Defaults to 250 ms
   * when unset. Runtime implementation lives in a later task.
   */
  crossfadeMs?: number;
  /**
   * Half-life in ms for the exponential decay used to return each channel to
   * its baseline value when no animation is actively driving it. A value of
   * 45000 ms means the deviation halves roughly every 45 seconds.
   * Runtime implementation lives in a later task.
   */
  baselineHalfLifeMs?: number;
  /**
   * Randomization controls applied by `AvatarService.enqueueTagAnimation`.
   * Does NOT affect state-transition nodes routed via `setActivity` /
   * `toStateNodes` — those paths stay deterministic.
   */
  jitter?: {
    /** Duration relative jitter ± amount. Default 0.15 = ±15%. 0 disables. */
    duration?: number;
    /** Intensity relative jitter ± amount. Default 0.10 = ±10%. 0 disables. */
    intensity?: number;
    /** Minimum floor for jittered intensity (post-clamp). Default 0.1. */
    intensityFloor?: number;
  };
}
