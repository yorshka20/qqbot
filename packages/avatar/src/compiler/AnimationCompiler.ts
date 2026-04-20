import { EventEmitter } from 'node:events';
import type { TunableParam, TunableSection } from '../preview/types';
import { type AvatarActivity, DEFAULT_ACTIVITY } from '../state/types';
import { ActionMap } from './action-map';
import { applyEasing } from './easing';
import {
  type AudioEnvelopeConfig,
  DEFAULT_AUDIO_ENVELOPE_CONFIG,
  getAudioEnvelopeConfig,
  setAudioEnvelopeConfig,
} from './layers/audio-envelope-config';
import { LayerManager } from './layers/LayerManager';
import type { AnimationLayer } from './layers/types';
import type {
  ActionSummary,
  ActiveAnimation,
  AnimationPhase,
  CompilerConfig,
  FrameOutput,
  ParamTarget,
  SpringParams,
  StateNode,
} from './types';

const DEFAULT_SPRING: SpringParams = { omega: 12, zeta: 1 };

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
  outputFps: 30,
  defaultEasing: 'easeInOutCubic',
  smoothingFactor: 0.3,
  attackRatio: 0.2,
  releaseRatio: 0.3,
};

/** Default crossfade duration in ms for overlapping animation channels. */
const DEFAULT_CROSSFADE_MS = 250;
/** Default half-life in ms for exponential baseline decay. */
const DEFAULT_BASELINE_HALF_LIFE_MS = 45_000;
/** Default ± relative jitter applied to enqueued tag-animation duration (15%). */
const DEFAULT_DURATION_JITTER = 0.15;
/** Default ± relative jitter applied to enqueued tag-animation intensity (10%). */
const DEFAULT_INTENSITY_JITTER = 0.1;
/** Default minimum intensity after jitter clamping. */
const DEFAULT_INTENSITY_FLOOR = 0.1;

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
  private currentActivity: AvatarActivity = { ...DEFAULT_ACTIVITY };

  constructor(config: Partial<CompilerConfig> = {}, actionMapPath?: string) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.actionMap = new ActionMap(actionMapPath);
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

  /** Public summary of every loaded action — see `ActionMap.listActions()`. */
  listActions(): ActionSummary[] {
    return this.actionMap.listActions();
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

  /**
   * Returns a summary of all currently active animations with their phase
   * and optional fade-out start timestamp for PreviewStatus snapshots.
   */
  getActiveAnimationDetails(): Array<{ name: string; phase: 'attack' | 'sustain' | 'release'; fadeOut?: number }> {
    return this.activeAnimations.map((a) => ({
      name: a.node.action,
      phase: a.phase,
      fadeOut: a.fadeOutStartMs,
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
      const resolved = this.actionMap.resolveAction(node.action, node.emotion, node.intensity);
      // Unknown action — skip silently
      if (!resolved) continue;
      const startTime = (node.timestamp || now) + (node.delay ?? 0);
      const endTime = startTime + node.duration + (resolved.holdMs ?? 0);

      // Gather channels driven by the incoming animation for crossfade conflict detection
      const newChannels = new Set(resolved.targets.map((t) => t.channel));

      // Mark any existing active animation that shares channels as fading out
      for (const existing of this.activeAnimations) {
        if (existing.fadeOutStartMs !== undefined) continue; // already fading
        const hasConflict = existing.targetParams.some((t) => newChannels.has(t.channel));
        if (hasConflict) {
          existing.fadeOutStartMs = startTime;
        }
      }

      this.activeAnimations.push({
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

  private tick(): void {
    const now = Date.now();

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

    // 4. Gather layer (continuous) contributions.
    const contributions: Record<string, number> = this.layerManager.sample(now, this.currentActivity);

    // 5. Identify channels currently being faded out so new animations can
    //    fade their conflicting channels in symmetrically.
    const fadingChannels = new Set<string>();
    for (const anim of this.activeAnimations) {
      if (anim.fadeOutStartMs !== undefined) {
        for (const t of anim.targetParams) fadingChannels.add(t.channel);
      }
    }

    // 6. Add active animation contributions with crossfade and endPose math.
    //    Per-target progress (leadMs/lagMs) lets each target have its own envelope
    //    window — skip targets whose window has not opened yet.
    for (const anim of this.activeAnimations) {
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

    // 7. Add baseline contributions so channels with endPose persist after
    //    their driving animation is gone.
    for (const [ch, v] of this.channelBaseline) {
      contributions[ch] = (contributions[ch] ?? 0) + v;
    }

    // 8. Advance spring-damper per driven channel (semi-implicit Euler —
    //    symplectic, stable on spring systems where explicit Euler diverges).
    const next: Record<string, number> = {};
    for (const id of Object.keys(contributions)) {
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
