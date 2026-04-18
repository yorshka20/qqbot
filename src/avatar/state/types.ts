export type BotState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'reacting';

/**
 * 本模块内自定义，结构与 src/avatar/compiler/types.ts 的 StateNode 一致。
 * 不要 import compiler 的类型，避免交叉依赖 —— 集成 ticket 会统一类型。
 */
export interface StateNodeOutput {
  action: string;
  emotion: string;
  intensity: number;
  /** 毫秒。0 表示持续到下一个状态切换（thinking 用）。 */
  duration: number;
  delay?: number;
  easing: string;
  timestamp?: number;
}

export interface IdleConfig {
  /** 待机动画随机间隔下界 (ms)，默认 3000 */
  idleIntervalMin: number;
  /** 待机动画随机间隔上界 (ms)，默认 8000 */
  idleIntervalMax: number;
}

export const DEFAULT_IDLE_CONFIG: IdleConfig = {
  idleIntervalMin: 3000,
  idleIntervalMax: 8000,
};
