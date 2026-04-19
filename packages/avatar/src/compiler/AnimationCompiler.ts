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
import type { ActionSummary, ActiveAnimation, CompilerConfig, FrameOutput, SpringParams, StateNode } from './types';

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

export class AnimationCompiler extends EventEmitter {
  private readonly config: CompilerConfig;
  private readonly actionMap: ActionMap;
  private readonly layerManager: LayerManager = new LayerManager();
  private pendingQueue: StateNode[] = [];
  private activeAnimations: ActiveAnimation[] = [];
  private currentParams: Record<string, number> = {};
  private springStates: Map<string, { position: number; velocity: number }> = new Map();
  private springOverrides: Map<string, Partial<SpringParams>> = new Map();
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
      const targets = this.actionMap.resolveAction(node.action, node.emotion, node.intensity);
      if (targets.length === 0) continue;
      const startTime = (node.timestamp || now) + (node.delay ?? 0);
      this.activeAnimations.push({
        node,
        startTime,
        endTime: startTime + node.duration,
        targetParams: targets,
        phase: 'attack',
      });
    }
  }

  private tick(): void {
    const now = Date.now();

    // Prune finished animations
    this.activeAnimations = this.activeAnimations.filter((a) => now < a.endTime);

    // Sum contributions from layers (continuous) + active animations (discrete ADSR).
    // Multiple sources targeting the same channel are additively mixed.
    const contributions: Record<string, number> = this.layerManager.sample(now, this.currentActivity);

    for (const anim of this.activeAnimations) {
      if (now < anim.startTime) continue;
      const progress = this.calculateProgress(anim, now);
      const eased = applyEasing(progress, anim.node.easing ?? this.config.defaultEasing);
      // Raw linear progress [0,1] — used to drive `oscillate` sinusoidal shape
      // separately from the ADSR envelope (which fades the oscillation in/out).
      const rawProgress = Math.min(1, (now - anim.startTime) / Math.max(1, anim.node.duration));
      for (const target of anim.targetParams) {
        const shape = target.oscillate ? Math.sin(2 * Math.PI * target.oscillate * rawProgress) : 1;
        const c = target.targetValue * eased * shape * target.weight;
        contributions[target.channel] = (contributions[target.channel] ?? 0) + c;
      }
    }

    // Advance spring-damper per driven channel (semi-implicit Euler —
    // symplectic, stable on spring systems where explicit Euler diverges).
    // dt clamped to 100ms to defend against pause/resume wall-clock gaps
    // (same reason as EyeGazeLayer's dt clamp).
    const rawDtMs = this.lastTickMs === 0 ? 1000 / this.config.fps : now - this.lastTickMs;
    const dt = Math.min(rawDtMs, 100) / 1000;
    this.lastTickMs = now;

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

    // Drop spring state for channels not driven this tick — preserves the
    // existing drop-on-release contract (downstream VTS falls back to its
    // own idle physics when a key disappears from the emitted frame).
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

  private calculateProgress(anim: ActiveAnimation, now: number): number {
    const elapsed = now - anim.startTime;
    const totalDuration = anim.node.duration;
    const attackTime = totalDuration * this.config.attackRatio;
    const releaseTime = totalDuration * this.config.releaseRatio;
    const sustainEnd = totalDuration - releaseTime;

    if (elapsed < attackTime) {
      anim.phase = 'attack';
      return attackTime === 0 ? 1 : elapsed / attackTime;
    }
    if (elapsed < sustainEnd) {
      anim.phase = 'sustain';
      return 1;
    }
    anim.phase = 'release';
    return releaseTime === 0 ? 0 : 1 - (elapsed - sustainEnd) / releaseTime;
  }
}

function humanizeLayerId(id: string): string {
  const title = id
    .split('-')
    .map((s) => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)))
    .join(' ');
  return `${title} Layer`;
}
