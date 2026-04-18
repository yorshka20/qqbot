import { EventEmitter } from 'node:events';
import { IDLE_ANIMATIONS, TRANSITION_ANIMATIONS } from './idle-animations';
import { type BotState, DEFAULT_IDLE_CONFIG, type IdleConfig, type StateNodeOutput } from './types';

/**
 * 管理 Bot 5 种表现状态。在 idle 状态时按随机间隔
 * (idleIntervalMin..idleIntervalMax) 发射 `idle-animation` 事件，
 * 在状态转换时通过 transition() 返回对应的 StateNode 列表。
 *
 * 事件：
 *   - `'idle-animation'`: (nodes: StateNodeOutput[])
 *   - `'state-change'`  : (from: BotState, to: BotState)
 */
export class IdleStateMachine extends EventEmitter {
  private state: BotState = 'idle';
  private readonly config: IdleConfig;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(config?: Partial<IdleConfig>) {
    super();
    this.config = { ...DEFAULT_IDLE_CONFIG, ...(config ?? {}) };
  }

  get currentState(): BotState {
    return this.state;
  }

  /**
   * 触发状态转换，返回该状态对应的过渡动画节点列表。
   * - 转到 idle：重启随机待机定时器
   * - 离开 idle：停掉待机定时器
   */
  transition(newState: BotState): StateNodeOutput[] {
    const prev = this.state;
    this.state = newState;

    if (prev !== newState) {
      this.emit('state-change', prev, newState);
    }

    if (newState === 'idle') {
      if (this.started) this.scheduleNextIdle();
    } else {
      this.clearIdleTimer();
    }

    // 深拷贝（加 timestamp）避免外部修改 shared 对象
    const now = Date.now();
    return TRANSITION_ANIMATIONS[newState].map((n) => ({ ...n, timestamp: now }));
  }

  /** 启动随机待机动画定时器（仅 idle 状态时实际 schedule） */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.state === 'idle') this.scheduleNextIdle();
  }

  /** 停止待机动画定时器 */
  stop(): void {
    this.started = false;
    this.clearIdleTimer();
  }

  // ---- internals ----

  private scheduleNextIdle(): void {
    this.clearIdleTimer();
    const { idleIntervalMin: lo, idleIntervalMax: hi } = this.config;
    const delay = lo + Math.random() * Math.max(0, hi - lo);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // 定时器到期时可能已经离开 idle；再检查一次
      if (!this.started || this.state !== 'idle') return;
      const pick = IDLE_ANIMATIONS[Math.floor(Math.random() * IDLE_ANIMATIONS.length)];
      const node: StateNodeOutput = { ...pick, timestamp: Date.now() };
      this.emit('idle-animation', [node]);
      // 动画结束后重新随机下一次（ticket 要求 setTimeout 而非 setInterval）
      this.scheduleNextIdle();
    }, delay);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
