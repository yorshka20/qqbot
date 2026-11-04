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
 * run on screen in the list after opening it acknowledged it, as a mail client does.
 */
export function buildInbox(runs: Run[], help: ClusterHelpRequest[], openRunId: string | null): InboxItem[] {
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
    const seen = run.task.acknowledgedAt !== undefined;
    const visible = !seen || run.task.id === openRunId;
    if ((run.stage === 'failed' || run.stage === 'blocked') && visible) {
      items.push({ kind: 'failed', key: `failed:${run.task.id}`, run, since: run.since });
    } else if (run.stage === 'review' || (run.task.id === openRunId && run.stage === 'done' && seen)) {
      items.push({ kind: 'review', key: `review:${run.task.id}`, run, since: run.since });
    }
  }

  return items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.since - b.since);
}

export interface InboxGroup<T = InboxItem> {
  label: string;
  items: T[];
}

/** Items keep the order they arrive in; groups are ordered by their earliest item. */
export function groupInboxByDay<T extends { since: number }>(items: T[], now: number): InboxGroup<T>[] {
  const byDay = new Map<string, T[]>();
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

/** askId → the answer the hub recorded, for a question that is no longer pending. */
export function answersOf(history: ClusterHelpRequest[]): Map<string, string> {
  const answers = new Map<string, string>();
  for (const request of history) {
    if (request.status !== 'pending' && request.answer !== undefined) {
      answers.set(request.id, request.answer);
    }
  }
  return answers;
}

export interface ArchiveItem {
  kind: 'answered' | 'failed' | 'review';
  id: string;
  run: Run;
  /** The answered question, when `kind === 'answered'`. */
  help?: ClusterHelpRequest;
  /** When it was handled: answeredAt / acknowledgedAt. */
  at: number;
}

/** What the inbox already dealt with, newest first. */
export function buildInboxArchive(runs: Run[], history: ClusterHelpRequest[]): ArchiveItem[] {
  const runById = new Map(runs.map((r) => [r.task.id, r]));
  const items: ArchiveItem[] = [];

  for (const request of history) {
    const run = request.taskId ? runById.get(request.taskId) : undefined;
    if (run && request.status !== 'pending' && request.answer !== undefined) {
      items.push({
        kind: 'answered',
        id: `answered:${request.id}`,
        run,
        help: request,
        at: toMs(request.answeredAt) ?? toMs(request.createdAt) ?? 0,
      });
    }
  }

  for (const run of runs) {
    const at = toMs(run.task.acknowledgedAt);
    if (at === null) {
      continue;
    }
    if (run.stage === 'failed' || run.stage === 'blocked') {
      items.push({ kind: 'failed', id: `failed:${run.task.id}`, run, at });
    } else if (run.stage === 'done' && run.task.status === 'completed') {
      items.push({ kind: 'review', id: `review:${run.task.id}`, run, at });
    }
  }

  return items.sort((a, b) => b.at - a.at);
}
