import type { BotState, StateNodeOutput } from './types';

/** idle 状态下随机挑选播放的微动作集合（至少 3 种） */
export const IDLE_ANIMATIONS: StateNodeOutput[] = [
  { action: 'blink', emotion: 'neutral', intensity: 1.0, duration: 300, easing: 'easeInOutCubic' },
  { action: 'head_sway', emotion: 'neutral', intensity: 0.3, duration: 3000, easing: 'linear' },
  { action: 'breathe', emotion: 'neutral', intensity: 0.2, duration: 4000, easing: 'easeInOutCubic' },
];

/**
 * 状态转换触发的过渡动画。
 * - `* → idle`：空数组（由 IdleStateMachine.start() 的定时器接管）
 * - `* → listening`：lean_forward（intensity 0.3）
 * - `* → thinking`：thinking（intensity 0.6，duration=0 表示持续）
 * - `* → speaking`：空数组（由 LLM 标签驱动）
 * - `* → reacting`：空数组（由事件决定）
 */
export const TRANSITION_ANIMATIONS: Record<BotState, StateNodeOutput[]> = {
  idle: [],
  listening: [{ action: 'lean_forward', emotion: 'neutral', intensity: 0.3, duration: 500, easing: 'easeInOutCubic' }],
  thinking: [{ action: 'thinking', emotion: 'neutral', intensity: 0.6, duration: 0, easing: 'easeInOutCubic' }],
  speaking: [],
  reacting: [],
};
