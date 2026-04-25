import { EventEmitter } from 'node:events';
import type { TunableParam, TunableSection } from '../preview/types';
import { logger } from '../utils/logger';

/** Per-second tick/emit rollup log. Off by default (non-zero I/O cost at 60Hz);
 *  enable with `AVATAR_PERF_LOG=1` when diagnosing frame-rate or event-loop issues. */
const PERF_LOG_ENABLED = process.env.AVATAR_PERF_LOG === '1';

import { type AvatarActivity, DEFAULT_ACTIVITY } from '../state/types';
import { ActionMap, type ResolveActionOptions } from './action-map';
import { sampleClip } from './clips/sampleClip';
import { applyEasing } from './easing';
import { AmbientAudioLayer } from './layers/AmbientAudioLayer';
import { AutoBlinkLayer } from './layers/AutoBlinkLayer';
import {
  type AudioEnvelopeConfig,
  DEFAULT_AUDIO_ENVELOPE_CONFIG,
  getAudioEnvelopeConfig,
  setAudioEnvelopeConfig,
} from './layers/audio-envelope-config';
import { BreathLayer } from './layers/BreathLayer';
import { EyeGazeLayer } from './layers/EyeGazeLayer';
import { HeadLookLayer } from './layers/HeadLookLayer';
import { IdleMotionLayer } from './layers/IdleMotionLayer';
import { LayerManager } from './layers/LayerManager';
import { PerlinNoiseLayer } from './layers/PerlinNoiseLayer';
import { PersonaPostureLayer } from './layers/PersonaPostureLayer';
import type { AnimationLayer } from './layers/types';
import { WalkingLayer } from './layers/WalkingLayer';
import { slerpQuat, slerpWithIdentity } from './quatMath';
import type {
  ActionSummary,
  ActiveAnimation,
  AnimationPhase,
  CompilerConfig,
  FrameOutput,
  ModelKind,
  ParamTarget,
  ResolvedAction,
  SpringParams,
  StateNode,
} from './types';

const DEFAULT_SPRING: SpringParams = { omega: 12, zeta: 1 };

/**
 * Defense-in-depth output clamp table — per-channel valid range applied at
 * the very end of `tick()` before the frame is emitted. Catches any upstream
 * additive overshoot (layer + action sums beyond the visual range), bug-
 * introduced negative values, or persona-modulation overflows. Channels not
 * listed pass through verbatim — root translation, custom morphs, and
 * artist-defined channels keep their full numeric range.
 *
 * Authoring conventions:
 * - eye/mouth/brow blendshapes are unit-interval `[0, 1]` (Cubism + VRM convention)
 * - head Euler is in degrees; ±45° / ±30° matches HeadLookLayer's natural caps
 * - brow has been observed authored in `[-1, 1]` (negative = furrowed)
 */
const CHANNEL_RANGE_TABLE: ReadonlyArray<readonly [string, readonly [number, number]]> = [
  ['eye.open.left', [0, 1]],
  ['eye.open.right', [0, 1]],
  ['eye.smile.left', [0, 1]],
  ['eye.smile.right', [0, 1]],
  ['mouth.smile', [0, 1]],
  ['mouth.open', [0, 1]],
  ['brow', [-1, 1]],
  ['head.yaw', [-45, 45]],
  ['head.pitch', [-30, 30]],
  ['head.roll', [-30, 30]],
];

const DEFAULT_SPRING_BY_CHANNEL: Record<string, SpringParams> = {
  'mouth.open': { omega: 25, zeta: 1 },
  'mouth.smile': { omega: 20, zeta: 1 },
  'eye.open.left': { omega: 20, zeta: 1 },
  'eye.open.right': { omega: 20, zeta: 1 },
  'eye.smile.left': { omega: 15, zeta: 1 },
  'eye.smile.right': { omega: 15, zeta: 1 },
  'eye.ball.x': { omega: 18, zeta: 1 },
  'eye.ball.y': { omega: 18, zeta: 1 },
  'head.yaw': { omega: 12, zeta: 1 },
  'head.pitch': { omega: 12, zeta: 1 },
  'head.roll': { omega: 12, zeta: 1 },
  'body.x': { omega: 7, zeta: 0.85 },
  'body.y': { omega: 7, zeta: 0.85 },
  'body.z': { omega: 7, zeta: 0.85 },
  brow: { omega: 15, zeta: 1 },
  breath: { omega: 10, zeta: 1 },
  'arm.right': { omega: 8, zeta: 0.9 },
};

const DEFAULT_CONFIG: CompilerConfig = {
  fps: 60,
  outputFps: 60,
  defaultEasing: 'easeInOutCubic',
  attackRatio: 0.2,
  releaseRatio: 0.3,
};

/** Default crossfade duration in ms for overlapping animation channels. */
const DEFAULT_CROSSFADE_MS = 250;
/** Default attack ramp duration in ms for clip-kind animations. */
const DEFAULT_CLIP_ATTACK_MS = 200;
/** Default release ramp duration in ms for clip-kind animations. */
const DEFAULT_CLIP_RELEASE_MS = 300;
/** Default half-life in ms for exponential baseline decay. */
const DEFAULT_BASELINE_HALF_LIFE_MS = 3_000;
/** Default ± relative jitter applied to enqueued tag-animation duration (15%). */
const DEFAULT_DURATION_JITTER = 0.15;
/** Default ± relative jitter applied to enqueued tag-animation intensity (10%). */
const DEFAULT_INTENSITY_JITTER = 0.1;
/** Default minimum intensity after jitter clamping. */
const DEFAULT_INTENSITY_FLOOR = 0.1;

/**
 * @property registerContinuousStack — Defaults to `true`: register the Live2D/VRM
 * continuous layer stack right after construction (same as production). Pass `false`
 * if you need an empty {@link LayerManager}, or use `newAnimationCompilerTest()` in
 * `__tests__/newAnimationCompilerTest.ts`.
 */
export type AnimationCompilerOptions = {
  registerContinuousStack?: boolean;
};

export class AnimationCompiler extends EventEmitter {
  private readonly config: CompilerConfig;
  private readonly actionMap: ActionMap;
  private readonly layerManager: LayerManager = new LayerManager();
  private pendingQueue: StateNode[] = [];
  private activeAnimations: ActiveAnimation[] = [];
  private currentParams: Record<string, number> = {};
  private springStates: Map<string, { position: number; velocity: number }> = new Map();
  private springOverrides: Map<string, Partial<SpringParams>> = new Map();
  /** Per-channel resting values written by endPose harvesting; decay over time. */
  private channelBaseline: Map<string, number> = new Map();
  /** Runtime overrides for envelope/crossfade tunables — take effect next tick. */
  private envelopeOverrides: { crossfadeMs?: number; baselineHalfLifeMs?: number } = {};
  /** Runtime overrides for jitter tunables — take effect on next enqueueTagAnimation call. */
  private jitterOverrides: { duration?: number; intensity?: number; intensityFloor?: number } = {};
  private lastTickMs = 0;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  // --- Perf instrumentation (per-second rollup, gated by AVATAR_PERF_LOG=1) ---
  private perfTickCount = 0;
  private perfEmitCount = 0;
  private perfMaxGapMs = 0;
  private perfMaxHandlerMs = 0;
  private perfHandlerSumMs = 0;
  private perfLastTickStartMs = 0;
  private perfLastLogEpochMs = 0;
  private currentActivity: AvatarActivity = { ...DEFAULT_ACTIVITY };
  /** Renderer model format last declared via hello handshake. Null = unknown (no hello received). */
  private currentModelKind: ModelKind | null = null;
  /**
   * Channels that bypass spring-damper smoothing and channel-baseline
   * addition this tick. Populated by two routes:
   *
   *   1. Quat contributions (`vrm.<bone>.qx/qy/qz/qw`) — the four scalar
   *      channels emitted per quat bone.
   *   2. Absolute-scalar layer contributions (`LayerFrame.scalarBypass`) —
   *      layers declaring `scalarIsAbsolute`, e.g. `WalkingLayer` root +
   *      walk-cycle bone Euler tracks.
   *
   * Cleared at the start of each tick. Values in this set are written
   * directly into `currentParams` and disappear on the first tick they are
   * not contributed (no spring state is created for them).
   */
  private bypassFrameChannels: Set<string> = new Set();

  constructor(config: Partial<CompilerConfig> = {}, actionMapPath?: string, options: AnimationCompilerOptions = {}) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.actionMap = new ActionMap(actionMapPath);
    if (options.registerContinuousStack !== false) {
      this.registerContinuousStack();
    }
  }

  /**
   * Live2D/VRM **continuous** stack: explicit list, fixed order, all stored
   * only in {@link LayerManager} (this is the single registry). Per-utterance
   * `AudioEnvelopeLayer` is registered later by {@link SpeechService}.
   */
  private registerContinuousStack(): void {
    // Instantiate EyeGazeLayer and PersonaPostureLayer explicitly so that
    // PersonaPostureLayer can wire itself to the gaze layer for
    // gazeContactPreference routing without exposing EyeGazeLayer in the
    // AvatarService public API.
    const eyeGaze = new EyeGazeLayer();
    const personaPosture = new PersonaPostureLayer();
    personaPosture.setEyeGazeLayer(eyeGaze);

    const debugQuiet = this.config.debugQuiet === true;
    if (debugQuiet) eyeGaze.setQuietMode(true);

    const headLook = new HeadLookLayer();

    const stack: AnimationLayer[] = [
      new BreathLayer(),
      new AutoBlinkLayer(),
      eyeGaze,
      // HeadLookLayer sits next to EyeGazeLayer: both are gaze-family layers driven by
      // deliberate override targets (setGazeTarget / setHeadLook), and visually the head
      // and eyes coordinate when looking somewhere.
      headLook,
    ];
    // IdleMotionLayer loops the resting-pose clip (e.g. peace_sign) and drives
    // hips/spine/chest channels continuously. Under debugQuiet we skip it so
    // the skeleton is still and only deliberate motion is observable.
    if (!debugQuiet) stack.push(new IdleMotionLayer());
    stack.push(
      new WalkingLayer(this.config.walk),
      // PersonaPostureLayer sits immediately after WalkingLayer: both are motion
      // layers that write body/spine/head channels, so keeping them adjacent makes
      // the stack intent readable. Ambient and perlin layers follow so they
      // contribute their independent noise on top of the motion group.
      personaPosture,
      new AmbientAudioLayer(),
    );
    if (!debugQuiet) {
      stack.push(new PerlinNoiseLayer({ weight: 0.2 }));
    }

    for (const layer of stack) {
      this.registerLayer(layer);
    }

    logger.info(
      `[AnimationCompiler] continuous stack → LayerManager:${debugQuiet ? ' [debugQuiet]' : ''}`,
      this.listLayers().map((l) => l.id),
    );
  }

  start(): void {
    if (this.tickInterval !== null) return;
    const intervalMs = Math.max(1, Math.round(1000 / this.config.fps));
    this.tickInterval = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.tickInterval !== null) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.pendingQueue = [];
    this.activeAnimations = [];
    this.tickCount = 0;
    this.springStates.clear();
    this.channelBaseline.clear();
    this.lastTickMs = 0;
  }

  /**
   * Pause the tick loop without dropping queued / active animation state.
   * Intended for consumer-presence gating — when no one is reading frames
   * (no VTS, no preview clients), pause to save CPU; call `resume()` when
   * a consumer reconnects.
   *
   * Layers keep their internal state intact; time-based layers re-align to
   * wall-clock on the next tick. `EyeGazeLayer` clamps its dt to prevent a
   * huge OU step after a long pause.
   */
  pause(): void {
    if (this.tickInterval === null) return;
    clearInterval(this.tickInterval);
    this.tickInterval = null;
  }

  /** Resume the tick loop. No-op if already running. Identical to `start()`. */
  resume(): void {
    this.start();
  }

  /** True iff the tick loop is currently running. */
  isTicking(): boolean {
    return this.tickInterval !== null;
  }

  enqueue(nodes: StateNode[]): void {
    this.pendingQueue.push(...nodes);
    this.processQueue();
  }

  getCurrentParams(): Record<string, number> {
    return { ...this.currentParams };
  }

  getActiveAnimationCount(): number {
    return this.activeAnimations.length;
  }

  getQueueLength(): number {
    return this.pendingQueue.length;
  }

  getActionDuration(action: string): number | undefined {
    return this.actionMap.getDuration(action);
  }

  /**
   * Channel footprint of an action, computed once at ActionMap load time.
   * Delegates to `ActionMap.getFootprint`. Used by schedulers (wander,
   * autonomous enqueue) to decide whether a candidate action would collide
   * with currently-active animations.
   */
  getActionFootprint(action: string): ReadonlySet<string> | null {
    return this.actionMap.getFootprint(action);
  }

  /**
   * Tier A / B channel occupancy — the set of channels currently claimed by
   * active discrete animations (both envelope and clip kinds). Fading-out
   * and release-phase animations still count as occupying their channels:
   * they're still writing contributions, and a new animation on the same
   * channels would triple-drive them (old tail + new attack + spring).
   *
   * **Does NOT include** Tier C ambient layers (breath, blink, perlin, gaze
   * noise) — those are designed to compose additively with absolute poses
   * and schedulers should not gate on them. Emotion channelBaseline is also
   * not included: emotions occupy a disjoint channel subset
   * (mouth / eye.smile / brow / cheek) that no action enqueue path targets
   * in practice.
   *
   * `opts.excludeActionName` skips animations whose source node's action
   * name matches — used by the enqueue path so a same-name re-enqueue
   * during release doesn't self-conflict (that's a chained-replay, not a
   * collision).
   */
  getOccupiedChannels(opts?: { excludeActionName?: string; includeContinuousLayers?: boolean }): Set<string> {
    const skip = opts?.excludeActionName;
    const occupied = new Set<string>();
    for (const anim of this.activeAnimations) {
      if (skip !== undefined && anim.node.action === skip) continue;
      if (anim.kind === 'envelope') {
        for (const t of anim.targetParams) occupied.add(t.channel);
      } else {
        for (const t of anim.clip.tracks) occupied.add(t.channel);
      }
    }
    // Continuous layers that hold absolute poses (idle loop, walk cycle) own
    // their channels every tick. Two callers, two semantics:
    //
    //  - Wander gate (`AvatarService.checkAvailable` → here with
    //    `includeContinuousLayers=true`): MUST see layer ownership so a
    //    wander step that translates the root is blocked while the idle
    //    layer holds the legs (otherwise the body slides while feet stay).
    //
    //  - Discrete cross-action enqueue (`processQueue` → here with the
    //    default false): MUST NOT see layer ownership, otherwise an idle
    //    interject like `[A:vrm_idle_loop_*]` would self-conflict against
    //    the basic-idle layer that's already holding pose. The layer's
    //    `activeChannels` filter mechanism (in LayerManager.sample) lets
    //    the layer yield its channels to discrete actions automatically;
    //    the arbiter shouldn't double-block.
    if (opts?.includeContinuousLayers) {
      for (const layer of this.layerManager.list()) {
        if (!layer.isEnabled() || !layer.getActiveChannels) continue;
        for (const ch of layer.getActiveChannels()) occupied.add(ch);
      }
    }
    return occupied;
  }

  /**
   * Intersection of `footprint` with the current Tier A/B occupancy. An
   * empty returned set means every channel in `footprint` is free and the
   * caller may proceed with enqueue. A non-empty set names the specific
   * conflicts; callers can log them, pick a different intent, or fall back.
   *
   * `opts.excludeActionName` has the same semantics as on
   * `getOccupiedChannels` — used by the enqueue path to avoid self-conflict
   * on same-name chained replays.
   */
  checkAvailable(
    footprint: Iterable<string>,
    opts?: { excludeActionName?: string; includeContinuousLayers?: boolean },
  ): Set<string> {
    const occupied = this.getOccupiedChannels(opts);
    const conflicts = new Set<string>();
    for (const ch of footprint) {
      if (occupied.has(ch)) {
        conflicts.add(ch);
        continue;
      }
      // Bidirectional base/axis match: an idle clip writing
      // `vrm.hips.x/y/z` (axis channels) must collide with a footprint that
      // declares `vrm.hips` (base channel), and vice versa. Without this the
      // wander gate misses idle-loop ownership entirely — its WALK_FOOTPRINT
      // uses base names while the clip tracks are authored with axes.
      let matched = false;
      for (const oc of occupied) {
        if (oc.startsWith(`${ch}.`)) {
          matched = true;
          break;
        }
      }
      if (matched) {
        conflicts.add(ch);
        continue;
      }
      const dot = ch.lastIndexOf('.');
      if (dot > 0 && occupied.has(ch.slice(0, dot))) {
        conflicts.add(ch);
      }
    }
    return conflicts;
  }

  /** Read-through for `ActionMap.getCategory`. Used by AvatarService to
   * supply category context to the mind-modulation provider so persona
   * per-category intensity scaling can be applied at enqueue time. */
  getActionCategory(action: string): string | undefined {
    return this.actionMap.getCategory(action);
  }

  /**
   * Companion face-action declared on a clip-kind action's `face` field.
   * `AvatarService.enqueueTagAnimation` reads this to fan a single tag into
   * body-clip + face-envelope pair (e.g. `vrm_emotion_laugh` + `emotion_smile`).
   */
  getActionFace(action: string): string | null {
    return this.actionMap.getFace(action);
  }

  /** Public summary of actions compatible with the current model kind. See `ActionMap.listActions()`. */
  listActions(): ActionSummary[] {
    return this.actionMap.listActions(this.currentModelKind);
  }

  /** Return the first preloaded IdleClip for a clip-kind action, or null. */
  getClipByActionName(name: string) {
    return this.actionMap.getClipByActionName(name);
  }

  /** Return every preloaded IdleClip variant for a clip-kind action, or null. */
  getClipsByActionName(name: string) {
    return this.actionMap.getClipsByActionName(name);
  }

  /** Register a continuous animation layer (breath, blink, gaze, idle clip…). */
  registerLayer(layer: AnimationLayer): void {
    this.layerManager.register(layer);
  }

  unregisterLayer(id: string): boolean {
    return this.layerManager.unregister(id);
  }

  getLayer(id: string): AnimationLayer | undefined {
    return this.layerManager.get(id);
  }

  listLayers(): AnimationLayer[] {
    return this.layerManager.list();
  }

  /**
   * Update the activity the compiler uses for the next tick. `ambientGain`
   * multiplies all layer contributions; `pose` is forwarded to layers that
   * care (currently only `IdleMotionLayer`). Replaces the old `setGateState`
   * — callers now own the scalar directly rather than routing through a
   * state-indexed lookup table.
   */
  setActivity(activity: AvatarActivity): void {
    this.currentActivity = { ...activity };
  }

  /**
   * Record the renderer model format declared by the latest hello handshake.
   * Null means the renderer has not yet loaded a model (or no hello received).
   * Filtering logic is not yet implemented — this is the contract/source step.
   */
  setCurrentModelKind(kind: ModelKind | null): void {
    this.currentModelKind = kind;
  }

  /** Return the model format last declared by hello handshake, or null if none. */
  getCurrentModelKind(): ModelKind | null {
    return this.currentModelKind;
  }

  /**
   * Shallow copy of all non-zero baseline values, rounded to 4 decimal places
   * to reduce WS bandwidth. Intended for PreviewStatus snapshots.
   */
  getChannelBaselineSnapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.channelBaseline) {
      out[k] = Math.round(v * 1e4) / 1e4;
    }
    return out;
  }

  /** Public read-through for pre-resolving an action by name. Used by
   * AvatarService.enqueueEmotion to get the envelope targets without
   * re-enqueueing the full action. Filtered by the current model kind. */
  resolveAction(
    action: string,
    emotion: string,
    intensity: number,
    opts?: ResolveActionOptions,
  ): ResolvedAction | null {
    return this.actionMap.resolveAction(action, emotion, intensity, this.currentModelKind, opts);
  }

  /** Seed emotion baseline directly. The next tick's baseline decay + mix
   * will carry these values until overwritten. Used by
   * AvatarService.enqueueEmotion so emotions persist past their ADSR
   * attack/release without modifying the core enqueue pathway. */
  seedChannelBaseline(entries: Array<{ channel: string; value: number }>): void {
    for (const e of entries) this.channelBaseline.set(e.channel, e.value);
  }

  /**
   * Returns a summary of all currently active animations with their phase
   * and optional fade-out start timestamp for PreviewStatus snapshots.
   */
  getActiveAnimationDetails(): Array<{
    name: string;
    phase: 'attack' | 'sustain' | 'release';
    fadeOut?: number;
    kind: 'envelope' | 'clip';
  }> {
    return this.activeAnimations.map((a) => ({
      name: a.node.action,
      phase: a.phase,
      fadeOut: a.fadeOutStartMs,
      kind: a.kind,
    }));
  }

  /**
   * Enumerate all tunable params visible to the HUD tuning panel. Includes
   * compiler-owned sections (spring damper, audio envelope singleton) plus
   * every registered layer that implements getTunableParams.
   */
  listTunableParams(): TunableSection[] {
    const sections: TunableSection[] = [];

    // Section 1: any registered layer that opts in via getTunableParams.
    // Skip audio-envelope-* layers — they share one singleton exposed
    // separately below.
    for (const layer of this.layerManager.list()) {
      if (layer.id.startsWith('audio-envelope')) continue;
      const params = layer.getTunableParams?.();
      if (!params || params.length === 0) continue;
      sections.push({
        id: `layer:${layer.id}`,
        label: humanizeLayerId(layer.id),
        params,
      });
    }

    // Section 2: layer:audio-envelope (compiler owns the singleton).
    const aec = getAudioEnvelopeConfig();
    sections.push({
      id: 'layer:audio-envelope',
      label: 'Audio Envelope Layer',
      params: [
        {
          id: 'threshold',
          label: 'Excite Threshold',
          min: 0,
          max: 1,
          step: 0.01,
          value: aec.threshold,
          default: DEFAULT_AUDIO_ENVELOPE_CONFIG.threshold,
        },
        {
          id: 'power',
          label: 'Excite Power',
          min: 0.3,
          max: 4,
          step: 0.05,
          value: aec.power,
          default: DEFAULT_AUDIO_ENVELOPE_CONFIG.power,
        },
        {
          id: 'bodyZMax',
          label: 'body.z Max',
          min: 0,
          max: 2,
          step: 0.05,
          value: aec.bodyZMax,
          default: DEFAULT_AUDIO_ENVELOPE_CONFIG.bodyZMax,
        },
        {
          id: 'eyeOpenMax',
          label: 'eye.open Max',
          min: 0,
          max: 1,
          step: 0.01,
          value: aec.eyeOpenMax,
          default: DEFAULT_AUDIO_ENVELOPE_CONFIG.eyeOpenMax,
        },
        {
          id: 'browMax',
          label: 'brow Max',
          min: 0,
          max: 2,
          step: 0.05,
          value: aec.browMax,
          default: DEFAULT_AUDIO_ENVELOPE_CONFIG.browMax,
        },
      ],
    });

    // Section 3: compiler:spring-damper — 6 channels × 2 params = 12
    const EXPOSED_CHANNELS = ['body.x', 'body.y', 'body.z', 'head.yaw', 'head.pitch', 'head.roll'];
    const springParams: TunableParam[] = [];
    for (const ch of EXPOSED_CHANNELS) {
      const defaults = DEFAULT_SPRING_BY_CHANNEL[ch] ?? DEFAULT_SPRING;
      const current = this.resolveSpringParams(ch);
      springParams.push(
        {
          id: `${ch}.omega`,
          label: `${ch} ω`,
          min: 1,
          max: 30,
          step: 0.5,
          value: current.omega,
          default: defaults.omega,
        },
        {
          id: `${ch}.zeta`,
          label: `${ch} ζ`,
          min: 0.3,
          max: 1.5,
          step: 0.05,
          value: current.zeta,
          default: defaults.zeta,
        },
      );
    }
    sections.push({
      id: 'compiler:spring-damper',
      label: 'Spring Damper',
      params: springParams,
    });

    // Section 4: compiler:envelope — crossfade + baseline half-life tunables
    sections.push({
      id: 'compiler:envelope',
      label: 'Envelope & Crossfade',
      params: [
        {
          id: 'crossfadeMs',
          label: 'Crossfade Duration',
          min: 0,
          max: 1000,
          step: 10,
          value: this.resolveCrossfadeMs(),
          default: DEFAULT_CROSSFADE_MS,
        },
        {
          id: 'baselineHalfLifeMs',
          label: 'Baseline Half-Life',
          min: 1000,
          max: 120000,
          step: 500,
          value: this.resolveBaselineHalfLifeMs(),
          default: DEFAULT_BASELINE_HALF_LIFE_MS,
        },
      ],
    });

    // Section 5: compiler:jitter — duration + intensity randomization
    const jitter = this.resolveJitter();
    sections.push({
      id: 'compiler:jitter',
      label: 'Randomization',
      params: [
        {
          id: 'durationJitter',
          label: 'Duration Jitter',
          min: 0,
          max: 0.5,
          step: 0.01,
          value: jitter.duration,
          default: DEFAULT_DURATION_JITTER,
        },
        {
          id: 'intensityJitter',
          label: 'Intensity Jitter',
          min: 0,
          max: 0.5,
          step: 0.01,
          value: jitter.intensity,
          default: DEFAULT_INTENSITY_JITTER,
        },
        {
          id: 'intensityFloor',
          label: 'Intensity Floor',
          min: 0,
          max: 0.5,
          step: 0.01,
          value: jitter.intensityFloor,
          default: DEFAULT_INTENSITY_FLOOR,
        },
      ],
    });

    return sections;
  }

  /**
   * Apply one tunable update. Routes by sectionId prefix. Unknown IDs are
   * silently dropped so older clients stay forward-compatible.
   */
  setTunableParam(sectionId: string, paramId: string, value: number): void {
    if (!Number.isFinite(value)) return;

    if (sectionId === 'compiler:spring-damper') {
      const lastDot = paramId.lastIndexOf('.');
      if (lastDot <= 0) return;
      const channel = paramId.slice(0, lastDot);
      const attr = paramId.slice(lastDot + 1);
      if (attr !== 'omega' && attr !== 'zeta') return;
      const existing = this.springOverrides.get(channel) ?? {};
      existing[attr] = value;
      this.springOverrides.set(channel, existing);
      return;
    }

    if (sectionId === 'compiler:envelope') {
      if (paramId === 'crossfadeMs') {
        this.envelopeOverrides.crossfadeMs = value;
      } else if (paramId === 'baselineHalfLifeMs') {
        this.envelopeOverrides.baselineHalfLifeMs = value;
      }
      return;
    }

    if (sectionId === 'compiler:jitter') {
      if (paramId === 'durationJitter') {
        this.jitterOverrides.duration = value;
      } else if (paramId === 'intensityJitter') {
        this.jitterOverrides.intensity = value;
      } else if (paramId === 'intensityFloor') {
        this.jitterOverrides.intensityFloor = value;
      }
      return;
    }

    if (sectionId === 'layer:audio-envelope') {
      setAudioEnvelopeConfig({ [paramId]: value } as Partial<AudioEnvelopeConfig>);
      return;
    }

    if (sectionId.startsWith('layer:')) {
      const layerId = sectionId.slice('layer:'.length);
      const layer = this.layerManager.get(layerId);
      layer?.setTunableParam?.(paramId, value);
      return;
    }
    // unknown: silent drop
  }

  private processQueue(): void {
    if (this.pendingQueue.length === 0) return;
    const now = Date.now();
    while (this.pendingQueue.length > 0) {
      const node = this.pendingQueue.shift();
      if (!node) continue;
      const resolved = this.actionMap.resolveAction(node.action, node.emotion, node.intensity, this.currentModelKind, {
        variantWeights: node.variantWeights,
      });
      // Unknown action — skip silently
      if (!resolved) continue;

      // Same-name dedup: if the same action is already active and has not
      // yet entered its release phase, drop the new enqueue outright. Two
      // instances of the same action on the same channels stack instead of
      // replaying cleanly (first half gets double intensity, second half
      // crossfades into itself). Release-phase same-name is allowed through
      // — that's an intentional chain-replay and the existing crossfade
      // path handles the tail overlap.
      const sameName = this.activeAnimations.find((a) => a.node.action === node.action);
      if (sameName && sameName.phase !== 'release') {
        logger.debug(
          `[AnimationCompiler] dedup: dropping "${node.action}" — same-name animation still in ${sameName.phase} phase`,
        );
        continue;
      }

      // Footprint occupancy: drop if another action (not same name) holds
      // any channel this one wants. Matches the "polite queue" contract —
      // LLM tags and autonomous enqueues respect channel ownership; explicit
      // preemption is not offered today. Same-name animations are excluded
      // so a release-phase chained replay passes through (handled by the
      // same-name branch above and the existing crossfade logic).
      const footprint = this.actionMap.getFootprint(node.action);
      if (footprint) {
        const conflicts = this.checkAvailable(footprint, { excludeActionName: node.action });
        if (conflicts.size > 0) {
          logger.debug(
            `[AnimationCompiler] dedup: dropping "${node.action}" — channels busy: ${[...conflicts].join(',')}`,
          );
          continue;
        }
      }

      const startTime = (node.timestamp || now) + (node.delay ?? 0);
      const endTime = startTime + node.duration + (resolved.holdMs ?? 0);

      // Channels the new animation will drive — for crossfade conflict detection.
      // For quat tracks, track.channel is the base bone channel (e.g. `vrm.hips`);
      // for scalar tracks it is the axis channel (e.g. `vrm.hips.y`). Compare at
      // track-channel granularity so quat vs quat conflicts are detected correctly.
      const newChannels =
        resolved.kind === 'clip'
          ? new Set(resolved.clip.tracks.map((t) => t.channel))
          : new Set(resolved.targets.map((t) => t.channel));

      // Mark any existing active animation that shares channels as fading out.
      for (const existing of this.activeAnimations) {
        if (existing.fadeOutStartMs !== undefined) continue;
        const existingChannels =
          existing.kind === 'clip'
            ? existing.clip.tracks.map((t) => t.channel)
            : existing.targetParams.map((t) => t.channel);
        const hasConflict = existingChannels.some((ch) => newChannels.has(ch));
        if (hasConflict) {
          existing.fadeOutStartMs = startTime;
        }
      }

      if (resolved.kind === 'clip') {
        this.activeAnimations.push({
          kind: 'clip',
          node,
          startTime,
          endTime,
          clip: resolved.clip,
          intensity: Math.max(0, Math.min(2, resolved.intensity)),
          phase: 'attack',
          endPose: resolved.endPose,
          fadeOutStartMs: undefined,
        });
      } else {
        this.activeAnimations.push({
          kind: 'envelope',
          node,
          startTime,
          endTime,
          targetParams: resolved.targets,
          endPose: resolved.endPose,
          phase: 'attack',
          fadeOutStartMs: undefined,
        });
      }
    }
  }

  private tick(): void {
    let handlerStart = 0;
    if (PERF_LOG_ENABLED) {
      handlerStart = performance.now();
      if (this.perfLastTickStartMs > 0) {
        const gap = handlerStart - this.perfLastTickStartMs;
        if (gap > this.perfMaxGapMs) this.perfMaxGapMs = gap;
      }
      this.perfLastTickStartMs = handlerStart;
      this.perfTickCount += 1;
    }

    const now = Date.now();

    // 0. Clear quat frame channel set from the previous tick.
    this.bypassFrameChannels.clear();

    // 1. Compute dt first so downstream steps share a consistent dt this tick.
    //    Clamp to 100ms to defend against pause/resume wall-clock gaps.
    const rawDtMs = this.lastTickMs === 0 ? 1000 / this.config.fps : now - this.lastTickMs;
    const dtMs = Math.min(rawDtMs, 100);
    const dt = dtMs / 1000;
    this.lastTickMs = now;

    // 2. Decay channelBaseline BEFORE harvesting newly finished animations.
    //    This prevents a one-tick "double count" where the same settle value
    //    would appear both from the baseline written last tick and the
    //    harvested animation this tick.
    const halfLife = this.resolveBaselineHalfLifeMs();
    const decayFactor = Math.exp((-dtMs * Math.LN2) / halfLife);
    for (const [ch, v] of this.channelBaseline) {
      const newV = v * decayFactor;
      if (Math.abs(newV) < 1e-4) {
        this.channelBaseline.delete(ch);
      } else {
        this.channelBaseline.set(ch, newV);
      }
    }

    // 3. Harvest finished or fully crossfaded-out animations.
    //    Write endPose values into channelBaseline and snap the spring to the
    //    settled position so the channel never blinks off between harvest and
    //    the spring pass below.
    const crossfadeMs = this.resolveCrossfadeMs();
    const toRemove = new Set<ActiveAnimation>();
    for (const anim of this.activeAnimations) {
      const isExpired = now >= anim.endTime;
      const isCrossfadeDone =
        anim.fadeOutStartMs !== undefined && (crossfadeMs === 0 || now - anim.fadeOutStartMs >= crossfadeMs);
      if (isExpired || isCrossfadeDone) {
        if (anim.endPose) {
          for (const entry of anim.endPose) {
            // Ignore endPose entries that target quat output channels; they use
            // slerp-with-identity and bypass the baseline/spring system.
            if (/\.q[xyzw]$/.test(entry.channel)) {
              console.warn(`[AnimationCompiler] endPose targets quat channel "${entry.channel}" — ignored`);
              continue;
            }
            const settled = entry.value * (entry.weight ?? 1);
            this.channelBaseline.set(entry.channel, settled);
            // Snap spring to the settled value so the channel doesn't
            // flicker to zero before the spring stabilises.
            this.springStates.set(entry.channel, { position: settled, velocity: 0 });
          }
        }
        toRemove.add(anim);
      }
    }
    this.activeAnimations = this.activeAnimations.filter((a) => !toRemove.has(a));

    // 4a. Compute the set of channels active animations will write this tick.
    //     Layers holding absolute (A-pose) values must skip these to avoid
    //     additive collision with the animation's target; delta-style layers
    //     ignore it. This set includes both in-progress and fading animations.
    const activeAnimChannels = new Set<string>();
    for (const anim of this.activeAnimations) {
      if (anim.kind === 'envelope') {
        for (const t of anim.targetParams) activeAnimChannels.add(t.channel);
      } else {
        for (const t of anim.clip.tracks) activeAnimChannels.add(t.channel);
      }
    }

    // 4b. Gather layer (continuous) contributions. Three routes:
    //     - `scalar`: additively merged, weighted, ambient-gated by LayerManager.
    //     - `scalarBypass`: absolute-pose scalars (e.g. WalkingLayer root /
    //       walk-cycle bone Euler) — written directly, marked for bypass
    //       (no spring-damper, no baseline). Last-writer-wins already
    //       happened inside LayerManager.
    //     - `quat`: absolute quaternion poses — expanded into the same
    //       `vrm.<bone>.q[xyzw]` channels as the discrete clip-path and
    //       marked for bypass.
    const layerFrame = this.layerManager.sample(now, this.currentActivity, activeAnimChannels, this.currentModelKind);
    const contributions: Record<string, number> = layerFrame.scalar;
    for (const [ch, v] of Object.entries(layerFrame.scalarBypass)) {
      contributions[ch] = v;
      this.bypassFrameChannels.add(ch);
    }
    for (const [bone, q] of Object.entries(layerFrame.quat)) {
      contributions[`${bone}.qx`] = q.x;
      contributions[`${bone}.qy`] = q.y;
      contributions[`${bone}.qz`] = q.z;
      contributions[`${bone}.qw`] = q.w;
      this.bypassFrameChannels.add(`${bone}.qx`);
      this.bypassFrameChannels.add(`${bone}.qy`);
      this.bypassFrameChannels.add(`${bone}.qz`);
      this.bypassFrameChannels.add(`${bone}.qw`);
    }

    // 5. Identify channels currently being faded out so new animations can
    //    fade their conflicting channels in symmetrically.
    //    For clip animations, track.channel is used directly (base channel for
    //    quat tracks, axis channel for scalar tracks) — matching the conflict
    //    detection key in processQueue.
    const fadingChannels = new Set<string>();
    for (const anim of this.activeAnimations) {
      if (anim.fadeOutStartMs !== undefined) {
        if (anim.kind === 'envelope') {
          for (const t of anim.targetParams) fadingChannels.add(t.channel);
        } else {
          for (const t of anim.clip.tracks) fadingChannels.add(t.channel);
        }
      }
    }

    // 6. Add active animation contributions with crossfade and endPose math.
    //    Clip-kind animations are sampled directly; envelope-kind use the
    //    per-target ADSR + leadMs/lagMs path below.
    for (const anim of this.activeAnimations) {
      if (anim.kind === 'clip') {
        if (now < anim.startTime) continue;
        const elapsedMs = now - anim.startTime;
        const clipDurMs = anim.clip.duration * 1000;
        const elapsedSec = Math.min(anim.clip.duration, elapsedMs / 1000);
        const sampled = sampleClip(anim.clip, elapsedSec, this.config.defaultEasing);

        const attackMs = this.config.clipEnvelope?.attackMs ?? DEFAULT_CLIP_ATTACK_MS;
        const releaseMs = this.config.clipEnvelope?.releaseMs ?? DEFAULT_CLIP_RELEASE_MS;
        // Clamp envelope windows to at most half the clip duration so short clips still get a proper ramp.
        const eA = Math.min(attackMs, clipDurMs * 0.5);
        const eR = Math.min(releaseMs, clipDurMs * 0.5);

        let envelopeScale = 1;
        let clipPhase: AnimationPhase = 'sustain';
        if (elapsedMs < eA) {
          envelopeScale = eA === 0 ? 1 : elapsedMs / eA;
          clipPhase = 'attack';
        } else if (elapsedMs > clipDurMs - eR) {
          envelopeScale = eR === 0 ? 0 : Math.max(0, (clipDurMs - elapsedMs) / eR);
          clipPhase = 'release';
        }
        anim.phase = clipPhase;

        // Crossfade: if clip is being faded out (conflict from later-enqueued anim),
        // fade-out scale drops 1→0 over crossfadeMs. Otherwise if ANY channel in
        // the clip is marked fadingChannels, fade-in scale climbs 0→1 over crossfadeMs.
        let fadeScale = 1;
        if (anim.fadeOutStartMs !== undefined) {
          const fp = crossfadeMs === 0 ? 1 : Math.min(1, Math.max(0, (now - anim.fadeOutStartMs) / crossfadeMs));
          fadeScale = 1 - fp;
        } else {
          const hasConflict = anim.clip.tracks.some((t) => fadingChannels.has(t.channel));
          if (hasConflict) {
            fadeScale = crossfadeMs === 0 ? 1 : Math.min(1, Math.max(0, (now - anim.startTime) / crossfadeMs));
          }
        }

        // Scalar tracks: additive accumulation with intensity/envelope/fade scaling.
        for (const [ch, v] of Object.entries(sampled.scalar)) {
          contributions[ch] = (contributions[ch] ?? 0) + v * anim.intensity * envelopeScale * fadeScale;
        }

        // Quat tracks: slerp FROM the current anchor TO the clip quat.
        // k = clamp(intensity * envelopeScale * fadeScale, 0, 1)
        //
        // Anchor resolution (per bone, per tick):
        //   1. Prefer `contributions[bone.q*]` if all four components are
        //      already populated — this is the upstream continuous-layer
        //      quat (typically IdleMotionLayer's idle-loop frame, written
        //      in step 4b). Using it as the slerp anchor means the release
        //      tail (k→0) blends back to the current idle pose rather than
        //      identity, avoiding the T-pose flash at clip end.
        //   2. Otherwise fall back to identity — preserves legacy behavior
        //      when no layer covers this bone (e.g. Cubism models, or tests
        //      without the continuous stack).
        //
        // Subsequent animations in `activeAnimations` will see THIS anim's
        // output as their anchor, giving a natural chained crossfade when
        // two animations target the same bone concurrently.
        for (const [bone, q] of Object.entries(sampled.quat)) {
          const k = Math.max(0, Math.min(1, anim.intensity * envelopeScale * fadeScale));
          const ax = contributions[`${bone}.qx`];
          const ay = contributions[`${bone}.qy`];
          const az = contributions[`${bone}.qz`];
          const aw = contributions[`${bone}.qw`];
          const hasAnchor = ax !== undefined && ay !== undefined && az !== undefined && aw !== undefined;
          const sq = hasAnchor
            ? slerpQuat(ax, ay, az, aw, q.x, q.y, q.z, q.w, k)
            : slerpWithIdentity(q.x, q.y, q.z, q.w, k);
          contributions[`${bone}.qx`] = sq.x;
          contributions[`${bone}.qy`] = sq.y;
          contributions[`${bone}.qz`] = sq.z;
          contributions[`${bone}.qw`] = sq.w;
          this.bypassFrameChannels.add(`${bone}.qx`);
          this.bypassFrameChannels.add(`${bone}.qy`);
          this.bypassFrameChannels.add(`${bone}.qz`);
          this.bypassFrameChannels.add(`${bone}.qw`);
        }

        continue;
      }

      if (anim.kind === 'envelope') {
        // Per-target envelope may start BEFORE anim.startTime (leadMs<0); outer
        // short-circuit removed so anticipation can land.
        const targetPhases: AnimationPhase[] = [];
        for (const target of anim.targetParams) {
          const tp = this.calculateTargetProgress(anim, target, now);
          if (tp === null) continue;
          targetPhases.push(tp.phase);

          const eased = applyEasing(tp.progress, anim.node.easing ?? this.config.defaultEasing);
          const easedClamped = Math.max(0, Math.min(1, eased));

          // Raw linear progress for oscillate uses the target's effective window.
          const effStart = anim.startTime + (target.leadMs ?? 0);
          const effEnd = anim.endTime + (target.lagMs ?? 0);
          const rawProgress = Math.min(1, (now - effStart) / Math.max(1, effEnd - effStart));

          let c: number;
          const endPoseEntry = anim.endPose?.find((e) => e.channel === target.channel);

          if (tp.phase === 'release' && endPoseEntry) {
            const peak = target.targetValue * target.weight;
            const settled = endPoseEntry.value * (endPoseEntry.weight ?? 1);
            const releaseProgress = 1 - easedClamped;
            c = peak + (settled - peak) * releaseProgress;
          } else {
            const shape = target.oscillate ? Math.sin(2 * Math.PI * target.oscillate * rawProgress) : 1;
            c = target.targetValue * easedClamped * shape * target.weight;
          }

          // Crossfade math — unchanged: operates at anim level, orthogonal to leadMs/lagMs.
          if (anim.fadeOutStartMs !== undefined) {
            const fp = crossfadeMs === 0 ? 1 : Math.min(1, Math.max(0, (now - anim.fadeOutStartMs) / crossfadeMs));
            c *= 1 - fp;
          } else if (fadingChannels.has(target.channel)) {
            const crossfadeIn = crossfadeMs === 0 ? 1 : Math.min(1, Math.max(0, (now - anim.startTime) / crossfadeMs));
            c *= crossfadeIn;
          }

          contributions[target.channel] = (contributions[target.channel] ?? 0) + c;
        }

        // Update anim.phase for PreviewStatus observability — take the first active
        // target's phase as the representative (nothing downstream relies on it
        // being a specific aggregation; HUD displays it as a hint).
        if (targetPhases.length > 0) anim.phase = targetPhases[0];
      }
    }

    // 7. Add baseline contributions so channels with endPose persist after
    //    their driving animation is gone. Quat frame channels bypass baseline —
    //    they are driven directly from the slerp path above.
    for (const [ch, v] of this.channelBaseline) {
      if (this.bypassFrameChannels.has(ch)) continue;
      contributions[ch] = (contributions[ch] ?? 0) + v;
    }

    // 8. Advance spring-damper per driven channel (semi-implicit Euler —
    //    symplectic, stable on spring systems where explicit Euler diverges).
    //    Quat frame channels bypass spring-damper: their contribution value
    //    enters currentParams directly and disappears the next tick they are
    //    not contributed (no spring state is created for them).
    const next: Record<string, number> = {};
    for (const id of Object.keys(contributions)) {
      if (this.bypassFrameChannels.has(id)) {
        // Bypass spring for quat output channels — use raw contribution value.
        next[id] = contributions[id];
        continue;
      }
      const target = contributions[id];
      const params = this.resolveSpringParams(id);
      let state = this.springStates.get(id);
      if (!state) {
        // First time seen — snap to target (do not spring-in from 0),
        // so e.g. lip-sync first frame matches the audio immediately
        // rather than crawling from 0 → target over ~50ms.
        state = { position: target, velocity: 0 };
        this.springStates.set(id, state);
      } else {
        const dx = target - state.position;
        const a = params.omega * params.omega * dx - 2 * params.zeta * params.omega * state.velocity;
        state.velocity += a * dt;
        state.position += state.velocity * dt;
      }
      next[id] = state.position;
    }

    // 9. Drop spring state for channels not driven this tick — preserves the
    //    existing drop-on-release contract (downstream VTS falls back to its
    //    own idle physics when a key disappears from the emitted frame).
    for (const id of this.springStates.keys()) {
      if (!(id in contributions)) this.springStates.delete(id);
    }

    // Defense-in-depth clamp: known semantic channels have natural valid
    // ranges (eye.open ∈ [0,1], head.yaw ∈ ±45°, etc.). Source-side bugs
    // (action authors, layer mis-mixing, additive overshoot) can produce
    // out-of-range values; clamping at the output boundary guarantees the
    // renderer never receives invalid params even if a component upstream
    // misbehaves. Channels not in the table pass through unchanged so root
    // translation, custom morphs, etc. retain their full numeric range.
    for (const [channel, range] of CHANNEL_RANGE_TABLE) {
      const v = next[channel];
      if (v === undefined) continue;
      if (v < range[0]) next[channel] = range[0];
      else if (v > range[1]) next[channel] = range[1];
    }

    this.currentParams = next;

    // Downsample and emit frame events at outputFps
    this.tickCount += 1;
    const emitEvery = Math.max(1, Math.round(this.config.fps / this.config.outputFps));
    if (this.tickCount % emitEvery === 0) {
      const frame: FrameOutput = {
        timestamp: now,
        params: { ...this.currentParams },
      };
      this.emit('frame', frame);
      if (PERF_LOG_ENABLED) this.perfEmitCount += 1;
    }

    if (PERF_LOG_ENABLED) {
      const handlerDur = performance.now() - handlerStart;
      this.perfHandlerSumMs += handlerDur;
      if (handlerDur > this.perfMaxHandlerMs) this.perfMaxHandlerMs = handlerDur;

      const nowEpoch = Date.now();
      if (this.perfLastLogEpochMs === 0) {
        this.perfLastLogEpochMs = nowEpoch;
      } else if (nowEpoch - this.perfLastLogEpochMs >= 1000) {
        const elapsedSec = (nowEpoch - this.perfLastLogEpochMs) / 1000;
        const avgHandler = this.perfTickCount > 0 ? this.perfHandlerSumMs / this.perfTickCount : 0;
        logger.info(
          `[compiler] tick/s=${(this.perfTickCount / elapsedSec).toFixed(1)} ` +
            `emit/s=${(this.perfEmitCount / elapsedSec).toFixed(1)} ` +
            `gapMax=${this.perfMaxGapMs.toFixed(1)}ms ` +
            `handlerAvg=${avgHandler.toFixed(2)}ms ` +
            `handlerMax=${this.perfMaxHandlerMs.toFixed(1)}ms ` +
            `active=${this.activeAnimations.length}`,
        );
        this.perfTickCount = 0;
        this.perfEmitCount = 0;
        this.perfMaxGapMs = 0;
        this.perfMaxHandlerMs = 0;
        this.perfHandlerSumMs = 0;
        this.perfLastLogEpochMs = nowEpoch;
      }
    }
  }

  private resolveSpringParams(channelId: string): SpringParams {
    const override = this.springOverrides.get(channelId);
    const fromConfig = this.config.springByChannel?.[channelId];
    const builtin = DEFAULT_SPRING_BY_CHANNEL[channelId];
    const base = fromConfig ?? builtin ?? this.config.springDefaults ?? DEFAULT_SPRING;
    if (!override) return base;
    return {
      omega: override.omega ?? base.omega,
      zeta: override.zeta ?? base.zeta,
    };
  }

  private resolveCrossfadeMs(): number {
    return this.envelopeOverrides.crossfadeMs ?? this.config.crossfadeMs ?? DEFAULT_CROSSFADE_MS;
  }

  private resolveBaselineHalfLifeMs(): number {
    return this.envelopeOverrides.baselineHalfLifeMs ?? this.config.baselineHalfLifeMs ?? DEFAULT_BASELINE_HALF_LIFE_MS;
  }

  private resolveJitter(): { duration: number; intensity: number; intensityFloor: number } {
    const cfg = this.config.jitter;
    return {
      duration: this.jitterOverrides.duration ?? cfg?.duration ?? DEFAULT_DURATION_JITTER,
      intensity: this.jitterOverrides.intensity ?? cfg?.intensity ?? DEFAULT_INTENSITY_JITTER,
      intensityFloor: this.jitterOverrides.intensityFloor ?? cfg?.intensityFloor ?? DEFAULT_INTENSITY_FLOOR,
    };
  }

  /**
   * Public read-through for consumers (AvatarService.enqueueTagAnimation)
   * that need to apply the currently-effective jitter. Accounts for HUD
   * tunable overrides.
   */
  getEffectiveJitter(): { duration: number; intensity: number; intensityFloor: number } {
    return this.resolveJitter();
  }

  /**
   * Per-target envelope progress. Replaces the old per-animation calculateProgress
   * so each ParamTarget can have its own leadMs/lagMs offset — supports
   * anticipation / secondary motion / follow-through at the authoring layer.
   *
   * Returns null when `now` is outside this target's effective window (either
   * before `anim.startTime + leadMs` or after `anim.endTime + lagMs`); callers
   * skip such targets this tick so they contribute 0.
   */
  private calculateTargetProgress(
    anim: ActiveAnimation,
    target: ParamTarget,
    now: number,
  ): { progress: number; phase: AnimationPhase } | null {
    const effStart = anim.startTime + (target.leadMs ?? 0);
    const effEnd = anim.endTime + (target.lagMs ?? 0);
    if (now < effStart) return null;
    const elapsed = now - effStart;
    const duration = effEnd - effStart;
    if (duration <= 0) return { progress: 0, phase: 'release' };
    const attackTime = duration * this.config.attackRatio;
    const releaseTime = duration * this.config.releaseRatio;
    const sustainEnd = duration - releaseTime;
    if (elapsed < attackTime) {
      return { progress: attackTime === 0 ? 1 : elapsed / attackTime, phase: 'attack' };
    }
    if (elapsed < sustainEnd) {
      return { progress: 1, phase: 'sustain' };
    }
    if (elapsed < duration) {
      return {
        progress: releaseTime === 0 ? 0 : 1 - (elapsed - sustainEnd) / releaseTime,
        phase: 'release',
      };
    }
    return null;
  }
}

function humanizeLayerId(id: string): string {
  const title = id
    .split('-')
    .map((s) => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)))
    .join(' ');
  return `${title} Layer`;
}
