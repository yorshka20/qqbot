import type { Run } from './runs';
import type { Tone } from './stage';

export type WorkerState = 'working' | 'asking' | 'failed' | 'idle' | 'exited';

export const WORKER_STATE_LABEL: Record<WorkerState, string> = {
  working: '在跑',
  asking: '等你',
  failed: '失败',
  idle: '空闲',
  exited: '已退出',
};

export const WORKER_STATE_TONE: Record<WorkerState, Tone> = {
  working: 'working',
  asking: 'attention',
  failed: 'failed',
  idle: 'muted',
  exited: 'muted',
};

export function workerState(run: Run | undefined): WorkerState {
  switch (run?.stage) {
    case 'asking':
      return 'asking';
    case 'running':
      return 'working';
    case 'failed':
    case 'blocked':
      return 'failed';
    case undefined:
      return 'idle';
    default:
      return 'exited';
  }
}

/** No run has a known duration, so the bar reads "how long this has been going", capped. */
export function elapsedFraction(elapsedMs: number, capMs = 30 * 60_000): number {
  return Math.min(1, Math.max(0, elapsedMs / capMs));
}
