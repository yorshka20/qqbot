import { modelDisplayName } from './model';
import { taskPath, workerPath } from './routes';
import { type Run, stageRankOfRun } from './runs';
import { isLive } from './stage';
import { toMs } from './time';
import { inWindow, type RunWindow } from './window';

export type TaskAttention = 'asking' | 'failed';

export interface TaskListItem {
  root: Run;
  /** Every descendant of the root, in spawn order. */
  children: Run[];
  attention: TaskAttention | null;
}

export interface TaskList {
  pinned: TaskListItem[];
  active: TaskListItem[];
  history: TaskListItem[];
}

const familyOf = (item: TaskListItem): Run[] => [item.root, ...item.children];

/** The latest moment any run in the family entered its current stage. */
export function latestSince(item: TaskListItem): number {
  return Math.max(...familyOf(item).map((run) => run.since));
}

function attentionOf(family: Run[]): TaskAttention | null {
  if (family.some((run) => run.stage === 'asking')) {
    return 'asking';
  }
  const unhandled = family.some(
    (run) => (run.stage === 'failed' || run.stage === 'blocked') && run.task.acknowledgedAt === undefined,
  );
  return unhandled ? 'failed' : null;
}

function buildItems(runs: Run[]): TaskListItem[] {
  const ids = new Set(runs.map((run) => run.task.id));
  const childrenOf = new Map<string, Run[]>();
  const roots: Run[] = [];
  for (const run of runs) {
    const parent = run.task.parentTaskId;
    if (parent && ids.has(parent)) {
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), run]);
    } else {
      roots.push(run);
    }
  }

  const descendants = (root: Run): Run[] => {
    const seen = new Set<string>([root.task.id]);
    const out: Run[] = [];
    const visit = (run: Run) => {
      for (const child of childrenOf.get(run.task.id) ?? []) {
        if (!seen.has(child.task.id)) {
          seen.add(child.task.id);
          out.push(child);
          visit(child);
        }
      }
    };
    visit(root);
    return out.sort((a, b) => (toMs(a.task.createdAt) ?? 0) - (toMs(b.task.createdAt) ?? 0));
  };

  return roots.map((root) => {
    const children = descendants(root);
    return { root, children, attention: attentionOf([root, ...children]) };
  });
}

function matches(item: TaskListItem, needle: string): boolean {
  return familyOf(item).some(
    (run) =>
      run.title.toLowerCase().includes(needle) ||
      (run.task.model ?? '').toLowerCase().includes(needle) ||
      modelDisplayName(run.task.model).toLowerCase().includes(needle),
  );
}

const rankOf = (item: TaskListItem): number => Math.min(...familyOf(item).map(stageRankOfRun));

/** One item per conversation: a root run with everything it spawned. */
export function buildTaskList(
  runs: Run[],
  opts: { now: number; query: string; historyWindow: RunWindow; pinned: ReadonlySet<string> },
): TaskList {
  const needle = opts.query.trim().toLowerCase();
  const items = buildItems(runs).filter((item) => needle === '' || matches(item, needle));

  const pinned: TaskListItem[] = [];
  const active: TaskListItem[] = [];
  const history: TaskListItem[] = [];
  for (const item of items) {
    if (opts.pinned.has(item.root.task.id)) {
      pinned.push(item);
      continue;
    }
    const family = familyOf(item);
    if (item.attention !== null || family.some((run) => isLive(run.task))) {
      active.push(item);
    } else if (family.some((run) => inWindow(run, opts.historyWindow, opts.now))) {
      history.push(item);
    }
  }

  pinned.sort((a, b) => latestSince(b) - latestSince(a));
  active.sort((a, b) => rankOf(a) - rankOf(b) || latestSince(a) - latestSince(b));
  history.sort((a, b) => latestSince(b) - latestSince(a));
  return { pinned, active, history };
}

/** Where opening a run goes: a root opens its task, a spawned run opens its place under the root. */
export function pathOfRun(run: Run, runs: Run[]): string {
  const byId = new Map(runs.map((candidate) => [candidate.task.id, candidate]));
  const seen = new Set<string>([run.task.id]);
  let root = run;
  for (let parent = root.task.parentTaskId; parent && byId.has(parent) && !seen.has(parent); ) {
    seen.add(parent);
    root = byId.get(parent) as Run;
    parent = root.task.parentTaskId;
  }
  return root === run ? taskPath(run.task.id) : workerPath(root.task.id, run.task.id);
}
