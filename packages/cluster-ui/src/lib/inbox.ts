import type { ClusterHelpRequest } from '@qqbot/api-types';
import type { Run } from './runs';
import { formatDayLabel, toMs } from './time';

export type InboxItem =
  | { kind: 'ask'; key: string; help: ClusterHelpRequest; run?: Run; since: number }
  | { kind: 'failed'; key: string; run: Run; since: number }
  | { kind: 'review'; key: string; run: Run; since: number };

const KIND_ORDER = { ask: 0, failed: 1, review: 2 } as const;

/**
 * One row per thing that waits on the owner: a run with two questions is two rows. A question
 * whose run already ended is dropped, nobody is left to read the answer. `openRunId` keeps the
 * run on screen in the list after opening it marked it seen, as a mail client does.
 */
export function buildInbox(
  runs: Run[],
  help: ClusterHelpRequest[],
  seen: ReadonlySet<string>,
  openRunId: string | null,
): InboxItem[] {
  const runById = new Map(runs.map((r) => [r.task.id, r]));
  const items: InboxItem[] = [];

  for (const request of help) {
    const run = request.taskId ? runById.get(request.taskId) : undefined;
    if (run && run.stage !== 'asking') {
      continue;
    }
    items.push({ kind: 'ask', key: `ask:${request.id}`, help: request, run, since: toMs(request.createdAt) ?? 0 });
  }

  for (const run of runs) {
    const visible = !seen.has(run.task.id) || run.task.id === openRunId;
    if ((run.stage === 'failed' || run.stage === 'blocked') && visible) {
      items.push({ kind: 'failed', key: `failed:${run.task.id}`, run, since: run.since });
    } else if (run.stage === 'review' || (run.task.id === openRunId && run.stage === 'done' && seen.has(run.task.id))) {
      items.push({ kind: 'review', key: `review:${run.task.id}`, run, since: run.since });
    }
  }

  return items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.since - b.since);
}

export interface InboxGroup {
  label: string;
  items: InboxItem[];
}

/** Items keep the order they arrive in; groups are ordered by their earliest item. */
export function groupInboxByDay(items: InboxItem[], now: number): InboxGroup[] {
  const byDay = new Map<string, InboxItem[]>();
  for (const item of items) {
    const dayKey = new Date(item.since).toDateString();
    const bucket = byDay.get(dayKey);
    if (bucket) {
      bucket.push(item);
    } else {
      byDay.set(dayKey, [item]);
    }
  }
  return [...byDay.values()]
    .map((bucket) => ({
      label: formatDayLabel(bucket[0].since, now),
      items: bucket,
      since: Math.min(...bucket.map((i) => i.since)),
    }))
    .sort((a, b) => a.since - b.since)
    .map(({ label, items: bucketItems }) => ({ label, items: bucketItems }));
}
