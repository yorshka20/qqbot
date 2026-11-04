import type { ClusterHelpRequest } from '@qqbot/api-types';
import { buildInbox, type InboxItem } from './inbox';
import type { Run } from './runs';
import { buildTaskList, latestSince, type TaskListItem } from './taskList';

export const HOME_ATTENTION_LIMIT = 5;

export interface HomeTotals {
  running: number;
  asking: number;
  queued: number;
  idle: number;
}

export interface Home {
  totals: HomeTotals;
  attention: InboxItem[];
  moreAttention: number;
  running: TaskListItem[];
  endedToday: TaskListItem[];
}

function startOfLocalDay(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function buildHome(runs: Run[], help: ClusterHelpRequest[], spareSlots: number, now: number): Home {
  const inbox = buildInbox(runs, help, null);
  const { active, history } = buildTaskList(runs, { now, query: '', historyWindow: '7d', pinned: new Set() });
  const dayStart = startOfLocalDay(now);

  return {
    totals: {
      running: runs.filter((run) => run.stage === 'running').length,
      asking: inbox.length,
      queued: runs.filter((run) => run.stage === 'queued').length,
      idle: spareSlots,
    },
    attention: inbox.slice(0, HOME_ATTENTION_LIMIT),
    moreAttention: Math.max(0, inbox.length - HOME_ATTENTION_LIMIT),
    running: active.filter((item) => [item.root, ...item.children].some((run) => run.stage === 'running')),
    endedToday: history.filter((item) => latestSince(item) >= dayStart),
  };
}
