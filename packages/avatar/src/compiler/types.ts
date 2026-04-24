/**
 * Discriminator for the renderer model format.
 * 'cubism' = Live2D Cubism; 'vrm' = VRM/three-vrm.
 */
export type ModelKind = 'cubism' | 'vrm';

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
 * Identifies which pipeline path produced an action node.
 * - 'llm': authored by an LLM reply tag (e.g. parsed from a [A:...] tag)
 * - 'autonomous': produced by a direct programmatic API call, not parsed from
 *   an LLM reply (e.g. `enqueueAutonomous` called by the mind system)
 *
 * Optional on StateNode for backward compatibility with state-machine
 * transition nodes that predate this field.
 */
export type StateNodeSource = 'llm' | 'autonomous';

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
  /**
   * Optional per-variant selection weights (persona modulation input).
   * Indexed positionally against the action-map's *declared* variant array.
   * Ignored when the action has a single variant or when length mismatches.
   * See `ActionMap.resolveAction` + `ResolveActionOptions`.
   */
  variantWeights?: readonly number[];
  /**
   * Pipeline source that produced this node. Absent on legacy / state-machine
   * transition nodes. Used in HUD debug traces and log lines to distinguish
   * LLM-driven and programmatic animation calls.
   */
  source?: StateNodeSource;
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

import type { IdleClip } from './layers/clips/types';

/**
 * Runtime state for an envelope-kind animation — legacy ADSR + ParamTarget
 * path. The compiler applies attack/sustain/release per target (with optional
 * leadMs/lagMs windows) and multiplies `targetParams[i].targetValue` (already
 * × intensity at resolve time) by the envelope shape each tick.
 */
export interface ActiveEnvelopeAnimation {
  kind: 'envelope';
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
  /** Optional end-pose to crossfade into once the main animation completes. */
  endPose?: ActionEndPoseEntry[];
  /** Wall-clock time (ms) at which the fade-out crossfade should begin. */
  fadeOutStartMs?: number;
}

/**
 * Runtime state for a clip-kind animation — samples a preloaded IdleClip per
 * tick and multiplies by intensity × envelope (attack/release constants) ×
 * crossfade. Intensity is NOT pre-applied to clip samples — it is multiplied
 * per-frame in the compiler's tick loop, mirroring the slerp(bind, clip,
 * intensity) semantic in linear approximation.
 */
export interface ActiveClipAnimation {
  kind: 'clip';
  /** The source state node for this animation */
  node: StateNode;
  /** Wall-clock time when this animation started (ms) */
  startTime: number;
  /** Wall-clock time when this animation ends (ms) */
  endTime: number;
  /** Preloaded IdleClip — sampled directly per tick. */
  clip: IdleClip;
  /** Per-frame multiplier. NOT pre-applied; tick multiplies every frame. */
  intensity: number;
  /** Current lifecycle phase — attack at start, release near end, sustain in between. */
  phase: AnimationPhase;
  /** Optional end-pose to persist selected channels after clip finishes. */
  endPose?: ActionEndPoseEntry[];
  /** Wall-clock time (ms) at which the fade-out crossfade should begin. */
  fadeOutStartMs?: number;
}

export type ActiveAnimation = ActiveEnvelopeAnimation | ActiveClipAnimation;

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

/** Discriminator for action execution strategy. */
export type ActionKind = 'envelope' | 'clip';

/**
 * The resolved output of `ActionMap.resolveAction()`.
 * Bundles either the scaled per-frame targets (envelope path) or a preloaded
 * IdleClip (clip path) together with the optional end-pose / hold duration.
 */
export type ResolvedAction =
  | {
      kind: 'envelope';
      /** Scaled (× intensity) parameter targets for the main animation phase. */
      targets: ParamTarget[];
      endPose?: ActionEndPoseEntry[];
      holdMs?: number;
      /** Default duration in ms — informational; caller uses StateNode.duration as authoritative. */
      duration: number;
      /** Original intensity carried through (envelope already applied it to targetValue). */
      intensity: number;
    }
  | {
      kind: 'clip';
      /** Preloaded IdleClip — AnimationCompiler samples directly, no re-read. */
      clip: IdleClip;
      endPose?: ActionEndPoseEntry[];
      holdMs?: number;
      duration: number;
      /** NOT pre-applied to clip samples — caller multiplies per tick for slerp-like scaling. */
      intensity: number;
    };

/**
 * Envelope-path action map entry — the legacy ADSR + ParamTarget format.
 * This is what every current `core-action-map.json` entry uses.
 */
export interface ActionMapEntryEnvelope {
  /** Discriminator. Absent defaults to 'envelope' for back-compat with existing action-map.json files. */
  kind?: 'envelope';
  /**
   * Optional renderer model compatibility declaration. Absent (undefined) means
   * compatible with both cubism and vrm — same as 'both'. Used by
   * `ActionMap.resolveAction()` and `listActions()` to filter by current model.
   */
  modelSupport?: 'cubism' | 'vrm' | 'both';
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
 * Clip-path action map entry — samples a pre-converted IdleClip JSON. Path
 * is relative to the action-map JSON's directory (typically
 * `packages/avatar/assets/`). A string array denotes a variant pool —
 * `resolveAction` picks one at random, same semantics as envelope variants.
 */
export interface ActionMapEntryClip {
  kind: 'clip';
  clip: string | string[];
  /** Override default duration; else derived from clip.duration * 1000 at load time. */
  defaultDuration?: number;
  category?: string;
  description?: string;
  endPose?: ActionEndPoseEntry[];
  holdMs?: number;
  /**
   * Optional renderer model compatibility declaration. Absent (undefined) means
   * compatible with both cubism and vrm — same as 'both'. Used by
   * `ActionMap.resolveAction()` and `listActions()` to filter by current model.
   */
  modelSupport?: 'cubism' | 'vrm' | 'both';
}

export type ActionMapEntry = ActionMapEntryEnvelope | ActionMapEntryClip;

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
 * Controls frame timing, ADSR ratio defaults, and spring-damper tuning.
 */
export interface CompilerConfig {
  /** Source capture framerate (fps) */
  fps: number;
  /** Output render framerate (fps) */
  outputFps: number;
  /** Default easing when none specified on a node */
  defaultEasing: EasingType;
  /** Attack phase ratio of the ADSR envelope (0.0–1.0) */
  attackRatio: number;
  /** Release phase ratio of the ADSR envelope (0.0–1.0) */
  releaseRatio: number;
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
   * Half-life in ms for the exponential decay of `endPose` baseline values
   * (set when envelope-kind animations release). Shorter = pose fades back
   * to idle-clip posture more quickly, reducing the window where a settled
   * envelope endPose competes with the idle loop for the same channel.
   * Default: 3000 ms (≈ one conversational turn). Older designs used 45 s
   * because there was no competing idle-clip pose layer.
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
  /**
   * Clip action-path envelope tunables. `attackMs` ramps the clip contribution
   * from 0 to 1 at start so the posture doesn't snap to the first frame;
   * `releaseMs` ramps back to 0 before the clip ends. Both clamped to half
   * the clip duration. Defaults: attackMs=200, releaseMs=300.
   */
  clipEnvelope?: {
    attackMs?: number;
    releaseMs?: number;
  };
  /**
   * Idle motion layer tuning. When `loopClipActionName` is set, the idle
   * layer continuously loops that action's clip (wrap to t=0 on reach of
   * duration) instead of the gap-based one-shot pool. The loop clip is the
   * single source of truth for the character's resting pose — when the bot
   * exits the "truly idle" gate (speaking / thinking / listening) the layer
   * freezes the clip at its current frame rather than letting channels fall
   * back to humanoid-identity T-pose.
   */
  idle?: {
    loopClipActionName?: string;
  };
  /**
   * Walking layer tuning. The layer owns VRM root motion while a walk is
   * pending; these values only affect the walking facade and do not change
   * idle/rest pose behavior.
   */
  walk?: {
    speedMps?: number;
    arrivalThresholdM?: number;
    /**
     * Action name (key in the merged action map) whose clip should loop on
     * WalkingLayer bone channels while a walk is pending. Omit / unresolved →
     * falls back to pure slide behavior (still emits vrm.root.* but no legs).
     */
    cycleClipActionName?: string;
  };
  /**
   * When true, skip registration of ambient micro-perturbation layers
   * (currently `PerlinNoiseLayer`) and freeze `EyeGazeLayer`'s OU drift so
   * the baseline is as still as possible. Intended for validating
   * deliberate motion (wander intents, LLM-driven actions, persona posture)
   * without head/body noise obscuring the effect. Default: false.
   */
  debugQuiet?: boolean;
}
