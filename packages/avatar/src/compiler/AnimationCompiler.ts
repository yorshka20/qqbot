import { EventEmitter } from 'node:events';
import { type AvatarActivity, DEFAULT_ACTIVITY } from '../state/types';
import { ActionMap } from './action-map';
import { applyEasing } from './easing';
import { LayerManager } from './layers/LayerManager';
import type { AnimationLayer } from './layers/types';
import type { ActionSummary, ActiveAnimation, CompilerConfig, FrameOutput, StateNode } from './types';

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

    // Low-pass toward contributions. Params not driven this tick are
    // dropped entirely so downstream (VTS / preview) knows we've released
    // control — VTS then falls back to its own idle/physics animation.
    const alpha = this.config.smoothingFactor;
    const next: Record<string, number> = {};
    for (const id of Object.keys(contributions)) {
      const prev = this.currentParams[id] ?? 0;
      next[id] = prev + (contributions[id] - prev) * alpha;
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
