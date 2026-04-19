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
  /** Smoothing factor for parameter blending (0.0–1.0) */
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
}
