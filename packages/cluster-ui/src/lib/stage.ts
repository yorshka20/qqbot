import type { ClusterTask } from '@qqbot/api-types';
import { toMs } from './time';

/**
 * What a run means to the owner. Phase 1 has no server-side stage, so it is derived:
 * pending help → asking; failed / blocked; completed and unseen → review; running; pending → queued.
 */
export type Stage = 'asking' | 'failed' | 'blocked' | 'review' | 'running' | 'queued' | 'done' | 'cancelled';

export const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

export const STAGE_LABEL: Record<Stage, string> = {
  asking: '等你回答',
  failed: '失败',
  blocked: '受阻',
  review: '待查看',
  running: '在跑',
  queued: '排队',
  done: '已完成',
  cancelled: '已终止',
};

export type Tone = 'attention' | 'working' | 'done' | 'failed' | 'muted';

export const STAGE_TONE: Record<Stage, Tone> = {
  asking: 'attention',
  failed: 'failed',
  blocked: 'failed',
  review: 'done',
  running: 'working',
  queued: 'muted',
  done: 'done',
  cancelled: 'muted',
};

export const TONE_TEXT: Record<Tone, string> = {
  attention: 'text-attention',
  working: 'text-working',
  done: 'text-done',
  failed: 'text-failed',
  muted: 'text-ink-muted',
};

export const TONE_BG: Record<Tone, string> = {
  attention: 'bg-attention',
  working: 'bg-working',
  done: 'bg-done',
  failed: 'bg-failed',
  muted: 'bg-ink-muted',
};

export function isLive(task: ClusterTask): boolean {
  return task.status === 'pending' || task.status === 'claimed' || task.status === 'running';
}

export function stageOf(task: ClusterTask, ctx: { asking: boolean; seen: boolean; now: number }): Stage {
  switch (task.status) {
    case 'pending':
    case 'claimed':
      return ctx.asking ? 'asking' : 'queued';
    case 'running':
      return ctx.asking ? 'asking' : 'running';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
    case 'completed': {
      const finished = toMs(task.completedAt) ?? toMs(task.createdAt) ?? 0;
      return !ctx.seen && ctx.now - finished < REVIEW_WINDOW_MS ? 'review' : 'done';
    }
  }
}

/** List order, design §3: what needs you, what runs, what waits, what ended. */
const STAGE_RANK: Record<Stage, number> = {
  asking: 0,
  failed: 1,
  blocked: 1,
  review: 2,
  running: 3,
  queued: 4,
  done: 5,
  cancelled: 5,
};

export function stageRank(stage: Stage): number {
  return STAGE_RANK[stage];
}
