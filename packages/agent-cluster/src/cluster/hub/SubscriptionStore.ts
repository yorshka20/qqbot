/**
 * SubscriptionStore — which events each task's worker asked to be woken for.
 *
 * Rows are keyed by the subscribing task, not its worker: `hub_spawn` subscribes a child that may
 * wait for a slot or a dependency before any worker exists, and a task has one worker for life.
 * Every read goes to `cluster_subscriptions`, so a daemon restart loses nothing and there is no
 * in-memory copy to reload.
 */

import type { Database } from 'bun:sqlite';
import { isAbsolute } from 'node:path';
import type { HubSubscribeInput, HubSubscriptions } from '../types';

type InterestKind = 'task' | 'file' | 'branch';

interface InterestRow {
  taskId: string;
  kind: InterestKind;
  target: string;
  dependency: number;
}

/** What just happened, in the terms interests are declared in. */
export interface InterestQuery {
  taskId?: string;
  branch?: boolean;
  files?: string[];
}

/** One subscribing task and which of its interests an event met. */
export interface InterestMatch {
  taskId: string;
  viaTask: boolean;
  viaBranch: boolean;
  /** The event's files that matched this task's `files` interests. */
  files: string[];
}

/** Worktree paths differ per worker, so only a repo-relative path can match another worker's lock or merge. */
export function normalizeInterestPath(path: string): string {
  const normalized = path.trim().replace(/^\.\//, '');
  if (!normalized || isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`"${path}" is not a repo-relative path or glob`);
  }
  return normalized;
}

function toRows(input: HubSubscribeInput): Array<{ kind: InterestKind; target: string }> {
  return [
    ...(input.tasks ?? []).map((target) => ({ kind: 'task' as const, target })),
    ...(input.files ?? []).map((target) => ({ kind: 'file' as const, target })),
    ...(input.branch ? [{ kind: 'branch' as const, target: '' }] : []),
  ];
}

export class SubscriptionStore {
  constructor(private readonly db: Database) {}

  /** With `dependency`, the `tasks` named must land before this task may start. */
  add(taskId: string, jobId: string, input: HubSubscribeInput, options: { dependency: boolean }): void {
    const insert = this.db.query(
      `INSERT INTO cluster_subscriptions (taskId, jobId, kind, target, dependency, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (taskId, kind, target) DO UPDATE SET dependency = MAX(dependency, excluded.dependency)`,
    );
    const now = Date.now();
    this.db.transaction(() => {
      for (const { kind, target } of toRows(input)) {
        insert.run(taskId, jobId, kind, target, options.dependency && kind === 'task' ? 1 : 0, now);
      }
    })();
  }

  /** Remove the named interests; naming none removes them all. */
  remove(taskId: string, input: HubSubscribeInput): void {
    const rows = toRows(input);
    if (rows.length === 0) {
      this.dropTask(taskId);
      return;
    }
    const remove = this.db.query('DELETE FROM cluster_subscriptions WHERE taskId = ? AND kind = ? AND target = ?');
    this.db.transaction(() => {
      for (const { kind, target } of rows) {
        remove.run(taskId, kind, target);
      }
    })();
  }

  dropTask(taskId: string): void {
    this.db.query('DELETE FROM cluster_subscriptions WHERE taskId = ?').run(taskId);
  }

  of(taskId: string): HubSubscriptions {
    const rows = this.db
      .query('SELECT * FROM cluster_subscriptions WHERE taskId = ? ORDER BY kind, target')
      .all(taskId) as InterestRow[];
    const tasks = rows.filter((r) => r.kind === 'task');
    return {
      tasks: tasks.map((r) => r.target),
      files: rows.filter((r) => r.kind === 'file').map((r) => r.target),
      branch: rows.some((r) => r.kind === 'branch'),
      dependsOn: tasks.filter((r) => r.dependency === 1).map((r) => r.target),
    };
  }

  dependenciesOf(taskId: string): string[] {
    return this.of(taskId).dependsOn;
  }

  /** The tasks of a job with an interest in this event, one entry each however many interests it met. */
  match(jobId: string, query: InterestQuery): InterestMatch[] {
    const rows = this.db.query('SELECT * FROM cluster_subscriptions WHERE jobId = ?').all(jobId) as InterestRow[];
    const matches = new Map<string, InterestMatch>();
    const entry = (taskId: string): InterestMatch => {
      const existing = matches.get(taskId);
      if (existing) {
        return existing;
      }
      const created: InterestMatch = { taskId, viaTask: false, viaBranch: false, files: [] };
      matches.set(taskId, created);
      return created;
    };
    for (const row of rows) {
      if (row.kind === 'task' && row.target === query.taskId) {
        entry(row.taskId).viaTask = true;
      } else if (row.kind === 'branch' && query.branch) {
        entry(row.taskId).viaBranch = true;
      } else if (row.kind === 'file' && query.files) {
        const glob = new Bun.Glob(row.target);
        const hit = query.files.filter((file) => glob.match(file));
        if (hit.length > 0) {
          const match = entry(row.taskId);
          match.files = Array.from(new Set([...match.files, ...hit]));
        }
      }
    }
    return Array.from(matches.values());
  }
}
