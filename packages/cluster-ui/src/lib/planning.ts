import type { ClusterJobSubmitBody, ClusterTask } from '@qqbot/api-types';

export type PlanningMode = NonNullable<ClusterJobSubmitBody['planning']>;

export const PLANNING_MODES: readonly PlanningMode[] = ['interactive', 'auto'];

export const PLANNING_MODE_LABEL: Record<PlanningMode, string> = {
  interactive: '先讨论方案再执行',
  auto: '直接执行',
};

export function parsePlanningMode(value: unknown): PlanningMode {
  return value === 'auto' ? 'auto' : 'interactive';
}

export type PlanningState = 'discussing' | 'executing' | 'done';

export const PLANNING_STATE_LABEL: Record<PlanningState, string> = {
  discussing: '讨论中',
  executing: '执行中',
  done: '已完成',
};

/** Queued, failed and stopped runs have no planning state: the stage badge already says so. */
export function planningState(
  task: Pick<ClusterTask, 'status'>,
  ctx: { isPlanner: boolean; asks: number; children: number },
): PlanningState | null {
  if (!ctx.isPlanner) {
    return null;
  }
  if (task.status === 'completed') {
    return 'done';
  }
  if (task.status !== 'running') {
    return null;
  }
  return ctx.asks > 0 && ctx.children === 0 ? 'discussing' : 'executing';
}
