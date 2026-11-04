import type { ClusterLock, ClusterWorkerRegistration } from '@qqbot/api-types';
import type { Run } from './runs';
import { isLive, STAGE_TONE, type Tone } from './stage';

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

export type TopologyNode =
  | { kind: 'project'; id: string; alias: string; x: number; y: number; w: number; h: number }
  | { kind: 'run'; id: string; run: Run; childRuns: number; x: number; y: number; w: number; h: number }
  | {
      kind: 'worker';
      id: string;
      worker: ClusterWorkerRegistration;
      state: WorkerState;
      run?: Run;
      lockedFiles: number;
      x: number;
      y: number;
      w: number;
      h: number;
    };

export interface TopologyEdge {
  id: string;
  from: string;
  to: string;
  path: string;
  tone: Tone;
  /** A run to a run it spawned: the ownership line, drawn heavier than a project's hold on its runs. */
  spawn: boolean;
}

export interface TopologyBand {
  alias: string;
  y: number;
  h: number;
}

export interface Topology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  bands: TopologyBand[];
  width: number;
  height: number;
}

export interface ProjectBranch {
  alias: string;
  roots: RunBranch[];
  /** Workers registered for the project with no run to hang them from. */
  idleWorkers: ClusterWorkerRegistration[];
}

export interface RunBranch {
  run: Run;
  children: RunBranch[];
}

/** What belongs on the map: the live runs, and what still waits in the inbox for the owner. */
function onMap(run: Run): boolean {
  if (isLive(run.task)) {
    return true;
  }
  return (
    (run.stage === 'failed' || run.stage === 'blocked' || run.stage === 'review') &&
    run.task.acknowledgedAt === undefined
  );
}

export function buildBranches(runs: Run[], workers: ClusterWorkerRegistration[]): ProjectBranch[] {
  const byId = new Map(runs.map((r) => [r.task.id, r]));
  const childrenOf = new Map<string, Run[]>();
  for (const run of runs) {
    const parent = run.task.parentTaskId;
    if (parent && byId.has(parent)) {
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), run]);
    }
  }

  const branch = (run: Run): RunBranch | null => {
    const children = (childrenOf.get(run.task.id) ?? []).flatMap((c) => branch(c) ?? []);
    return onMap(run) || children.length > 0 ? { run, children } : null;
  };

  const projects = new Map<string, ProjectBranch>();
  const project = (alias: string): ProjectBranch => {
    const known = projects.get(alias) ?? { alias, roots: [], idleWorkers: [] };
    projects.set(alias, known);
    return known;
  };

  for (const run of runs) {
    const parent = run.task.parentTaskId;
    if (parent && byId.has(parent)) {
      continue;
    }
    const root = branch(run);
    if (root) {
      project(run.task.project).roots.push(root);
    }
  }

  const boundWorkers = new Set(runs.flatMap((r) => (r.task.workerId ? [r.task.workerId] : [])));
  for (const worker of workers) {
    if (worker.status !== 'exited' && !boundWorkers.has(worker.workerId)) {
      project(worker.project).idleWorkers.push(worker);
    }
  }

  return [...projects.values()].sort((a, b) => a.alias.localeCompare(b.alias));
}

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

const PROJECT_W = 132;
const RUN_W = 264;
const WORKER_W = 312;
const COLUMN_GAP = 48;
const RUN_H = 84;
const WORKER_H = 124;
const ROW_GAP = 16;
const BAND_PAD = 8;
const CORNER_RADIUS = 6;
const PROJECT_GAP = 30;
const PROJECT_H = 46;

/** Right, vertical, right, with each corner rounded by an arc that shrinks to fit a short rise. */
function elbow(fromX: number, fromY: number, toX: number, toY: number): string {
  const rise = toY - fromY;
  if (rise === 0) {
    return `M${fromX} ${fromY}H${toX}`;
  }
  const mid = toX - COLUMN_GAP / 2;
  const r = Math.min(CORNER_RADIUS, Math.abs(rise) / 2);
  const dir = Math.sign(rise);
  const turnIn = dir > 0 ? 1 : 0;
  return (
    `M${fromX} ${fromY}H${mid - r}A${r} ${r} 0 0 ${turnIn} ${mid} ${fromY + dir * r}` +
    `V${toY - dir * r}A${r} ${r} 0 0 ${1 - turnIn} ${mid + r} ${toY}H${toX}`
  );
}

/** No run has a known duration, so the bar reads "how long this has been going", capped. */
export function elapsedFraction(elapsedMs: number, capMs = 30 * 60_000): number {
  return Math.min(1, Math.max(0, elapsedMs / capMs));
}

/**
 * A left-to-right tree. Leaves take the next free row and a parent centres on its children,
 * so the layout is one depth-first pass and needs no force simulation. A run's own worker is
 * its first child; the runs a planner spawned follow it, one column further right.
 */
export function layoutTopology(branches: ProjectBranch[], locks: ClusterLock[]): Topology {
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const bands: TopologyBand[] = [];
  let cursor = 0;
  let right = 0;

  const lockCount = (workerId: string): number => locks.filter((l) => l.workerId === workerId).length;

  const placeWorker = (worker: ClusterWorkerRegistration, run: Run | undefined, x: number): TopologyNode => {
    const node: TopologyNode = {
      kind: 'worker',
      id: `worker:${worker.workerId}`,
      worker,
      state: workerState(run),
      run,
      lockedFiles: lockCount(worker.workerId),
      x,
      y: cursor,
      w: WORKER_W,
      h: WORKER_H,
    };
    cursor += WORKER_H + ROW_GAP;
    right = Math.max(right, x + WORKER_W);
    nodes.push(node);
    return node;
  };

  const connect = (from: TopologyNode, to: TopologyNode, tone: Tone): void => {
    edges.push({
      id: `${from.id}>${to.id}`,
      from: from.id,
      to: to.id,
      path: elbow(from.x + from.w, from.y + from.h / 2, to.x, to.y + to.h / 2),
      tone,
      spawn: from.kind === 'run' && to.kind === 'run',
    });
  };

  const placeRun = (branch: RunBranch, x: number): TopologyNode => {
    const childX = x + RUN_W + COLUMN_GAP;
    const placed: TopologyNode[] = [];
    if (branch.run.worker) {
      placed.push(placeWorker(branch.run.worker, branch.run, childX));
    }
    for (const child of branch.children) {
      placed.push(placeRun(child, childX));
    }

    let y: number;
    if (placed.length > 0) {
      const first = placed[0];
      const last = placed[placed.length - 1];
      y = (first.y + first.h / 2 + last.y + last.h / 2) / 2 - RUN_H / 2;
    } else {
      y = cursor;
      cursor += RUN_H + ROW_GAP;
    }

    const node: TopologyNode = {
      kind: 'run',
      id: `run:${branch.run.task.id}`,
      run: branch.run,
      childRuns: branch.children.length,
      x,
      y,
      w: RUN_W,
      h: RUN_H,
    };
    right = Math.max(right, x + RUN_W);
    nodes.push(node);
    for (const child of placed) {
      connect(node, child, STAGE_TONE[branch.run.stage]);
    }
    return node;
  };

  for (const project of branches) {
    const top = cursor;
    const runX = PROJECT_W + COLUMN_GAP;
    const placed = project.roots.map((root) => placeRun(root, runX));
    for (const worker of project.idleWorkers) {
      placed.push(placeWorker(worker, undefined, runX));
    }
    const bottom = cursor - ROW_GAP;
    const node: TopologyNode = {
      kind: 'project',
      id: `project:${project.alias}`,
      alias: project.alias,
      x: 0,
      y: (top + bottom) / 2 - PROJECT_H / 2,
      w: PROJECT_W,
      h: PROJECT_H,
    };
    nodes.push(node);
    for (const child of placed) {
      connect(node, child, 'muted');
    }
    bands.push({ alias: project.alias, y: top - BAND_PAD, h: bottom - top + BAND_PAD * 2 });
    cursor += PROJECT_GAP;
  }

  return { nodes, edges, bands, width: right, height: Math.max(0, cursor - PROJECT_GAP - ROW_GAP) };
}
