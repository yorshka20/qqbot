import { EventEmitter } from 'node:events';
import { ActionMap } from './action-map';
import { applyEasing } from './easing';
import type { ActiveAnimation, CompilerConfig, FrameOutput, StateNode } from './types';

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
  private pendingQueue: StateNode[] = [];
  private activeAnimations: ActiveAnimation[] = [];
  private currentParams: Record<string, number> = {};
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;

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

  enqueue(nodes: StateNode[]): void {
    this.pendingQueue.push(...nodes);
    this.processQueue();
  }

  getCurrentParams(): Record<string, number> {
    return { ...this.currentParams };
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

    // 淘汰结束的动画
    this.activeAnimations = this.activeAnimations.filter((a) => now < a.endTime);

    // 以当前参数为基线，叠加活跃动画
    const frameParams: Record<string, number> = { ...this.currentParams };
    for (const anim of this.activeAnimations) {
      if (now < anim.startTime) continue;
      const progress = this.calculateProgress(anim, now);
      const eased = applyEasing(progress, anim.node.easing ?? this.config.defaultEasing);
      for (const target of anim.targetParams) {
        const baseValue = frameParams[target.paramId] ?? 0;
        const delta = (target.targetValue - baseValue) * eased * target.weight;
        frameParams[target.paramId] = baseValue + delta;
      }
    }

    // 低通滤波平滑
    const alpha = this.config.smoothingFactor;
    for (const paramId of Object.keys(frameParams)) {
      const targetValue = frameParams[paramId] ?? 0;
      const current = this.currentParams[paramId] ?? 0;
      this.currentParams[paramId] = current + (targetValue - current) * alpha;
    }

    // 按 outputFps 降采样发射 frame 事件
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
