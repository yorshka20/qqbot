import type {
  ClusterHelpRequest,
  ClusterTask,
  ClusterTemplatesResponse,
  ClusterWorkerRegistration,
  TicketCreateBody,
} from '@qqbot/api-types';
import { isLive, type Stage, stageOf, stageRank } from './stage';
import { toMs } from './time';
import { inWindow, type RunWindow } from './window';

export type RunView = 'chat' | 'log' | 'result';

export const RUN_VIEWS: readonly RunView[] = ['chat', 'log', 'result'];

export const RUN_VIEW_LABEL: Record<RunView, string> = {
  chat: '对话',
  log: '日志',
  result: '结果',
};

export function parseRunView(value: string | null | undefined): RunView | null {
  return RUN_VIEWS.find((view) => view === value) ?? null;
}

export interface Run {
  task: ClusterTask;
  stage: Stage;
  title: string;
  ticketId?: string;
  worker?: ClusterWorkerRegistration;
  /** Pending questions, oldest first. */
  asks: ClusterHelpRequest[];
  /** When the current stage began: what "等了多久" and "已跑" count from. */
  since: number;
}

export interface TaskRow {
  task: ClusterTask;
  ticketId?: string;
}

const TITLE_MAX = 120;

const FRONTMATTER = /^---\n(?:([\s\S]*?)\n)?---\n?/;
const TASK_PREFIX = /^(?:任务|Task|目标)\s*[:：]\s*/i;
const SYMBOLS_ONLY = /^[-=_*~>\s]+$/;

function plainLine(raw: string): string {
  const line = raw.trim();
  if (SYMBOLS_ONLY.test(line)) {
    return '';
  }
  return line
    .replace(/^#+\s*/, '')
    .replace(/^>\s*/, '')
    .replace(/^(?:[-*]|\d+\.)\s+/, '')
    .replace(TASK_PREFIX, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/**
 * The first line a person would call the title. A ticket-dispatched description starts with
 * its frontmatter block, whose `title:` is the better name.
 */
export function runTitle(description: string): string {
  let text = description.trim();
  const frontmatter = text.match(FRONTMATTER);
  if (frontmatter) {
    const named = frontmatter[1]?.match(/^title:\s*(.+)$/m);
    if (named) {
      return named[1].trim().replace(/^["']|["']$/g, '');
    }
    text = text.slice(frontmatter[0].length);
  }
  const line = text
    .split('\n')
    .map(plainLine)
    .find((l) => l.length > 0);
  if (!line) {
    return '（无描述）';
  }
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line;
}

/** The description without its dispatch frontmatter: what a person actually asked for. */
export function runBody(description: string): string {
  const lead = description.trimStart();
  const frontmatter = lead.match(FRONTMATTER);
  const body = frontmatter ? lead.slice(frontmatter[0].length).replace(/^\n+/, '') : description;
  return body.trimEnd();
}

function stageSince(task: ClusterTask, stage: Stage, asks: ClusterHelpRequest[]): number {
  const created = toMs(task.createdAt) ?? 0;
  switch (stage) {
    case 'asking':
      return toMs(asks[0]?.createdAt) ?? created;
    case 'running':
      return toMs(task.workerStartedAt) ?? toMs(task.startedAt) ?? created;
    case 'queued':
      return created;
    default:
      return toMs(task.completedAt) ?? created;
  }
}

export function buildRuns(
  rows: TaskRow[],
  help: ClusterHelpRequest[],
  workers: ClusterWorkerRegistration[],
  now: number,
): Run[] {
  const workerById = new Map(workers.map((w) => [w.workerId, w]));
  return rows.map(({ task, ticketId }) => {
    const asks = isLive(task)
      ? help.filter((h) => h.taskId === task.id).sort((a, b) => (toMs(a.createdAt) ?? 0) - (toMs(b.createdAt) ?? 0))
      : [];
    const stage = stageOf(task, { asking: asks.length > 0, seen: task.acknowledgedAt !== undefined, now });
    return {
      task,
      stage,
      title: runTitle(task.description),
      ticketId,
      worker: task.workerId ? workerById.get(task.workerId) : undefined,
      asks,
      since: stageSince(task, stage, asks),
    };
  });
}

/** Stage order; a stage that needs you or runs longest-waiting first, ended ones newest first. */
export function sortRuns(runs: Run[]): Run[] {
  return [...runs].sort((a, b) => {
    const byStage = stageRank(a.stage) - stageRank(b.stage);
    if (byStage !== 0) {
      return byStage;
    }
    return stageRank(a.stage) >= stageRank('done') ? b.since - a.since : a.since - b.since;
  });
}

export interface RunTreeRow {
  run: Run;
  /** 0 for a root; a planner's spawned run is 1, its own children 2, … */
  depth: number;
  /** Last among its parent's children: the tree rail stops at the elbow. */
  lastChild: boolean;
  /** How many runs this one spawned; 0 means no role label. */
  childRuns: number;
}

/** sortRuns order for families, spawn order inside one. */
export function orderRunsAsTree(runs: Run[]): RunTreeRow[] {
  const ids = new Set(runs.map((r) => r.task.id));
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
  for (const siblings of childrenOf.values()) {
    siblings.sort((a, b) => (toMs(a.task.createdAt) ?? 0) - (toMs(b.task.createdAt) ?? 0));
  }

  const familyRank = (run: Run): number =>
    Math.min(stageRank(run.stage), ...(childrenOf.get(run.task.id) ?? []).map(familyRank));
  const rankOf = new Map(roots.map((root) => [root.task.id, familyRank(root)]));
  const orderedRoots = sortRuns(roots).sort((a, b) => (rankOf.get(a.task.id) ?? 0) - (rankOf.get(b.task.id) ?? 0));

  const rows: RunTreeRow[] = [];
  const walk = (run: Run, depth: number, lastChild: boolean) => {
    const children = childrenOf.get(run.task.id) ?? [];
    rows.push({ run, depth, lastChild, childRuns: children.length });
    for (const [index, child] of children.entries()) {
      walk(child, depth + 1, index === children.length - 1);
    }
  };
  for (const root of orderedRoots) {
    walk(root, 0, false);
  }
  return rows;
}

export type RunSectionKey = 'attention' | 'running' | 'queued' | 'ended';

export const RUN_SECTION_LABEL: Record<RunSectionKey, string> = {
  attention: '需要你',
  running: '在跑',
  queued: '排队',
  ended: '已结束',
};

export interface RunSection {
  key: RunSectionKey;
  rows: RunTreeRow[];
}

const SECTION_ORDER: RunSectionKey[] = ['attention', 'running', 'queued', 'ended'];

const SECTION_RANK: Record<RunSectionKey, number> = {
  attention: 0,
  running: 1,
  queued: 2,
  ended: 3,
};

const SECTION_OF_STAGE: Record<Stage, RunSectionKey> = {
  asking: 'attention',
  failed: 'attention',
  blocked: 'attention',
  review: 'attention',
  running: 'running',
  queued: 'queued',
  done: 'ended',
  cancelled: 'ended',
};

function familyRoot(run: Run, byId: ReadonlyMap<string, Run>): Run {
  const seen = new Set<string>();
  let current = run;
  while (current.task.parentTaskId && byId.has(current.task.parentTaskId)) {
    if (seen.has(current.task.id)) {
      break;
    }
    seen.add(current.task.id);
    const parent = byId.get(current.task.parentTaskId);
    if (!parent) {
      break;
    }
    current = parent;
  }
  return current;
}

/**
 * The runs split into four sections, and one family — a root and every run under it — lands in a
 * single section: the earliest one any member needs, so a planner's child never leaves its parent
 * behind. Only the ended section is bounded by the window.
 */
export function groupRunSections(runs: Run[], opts: { now: number; window: RunWindow }): RunSection[] {
  const byId = new Map(runs.map((run) => [run.task.id, run]));
  const families = new Map<string, Run[]>();
  for (const run of runs) {
    const rootId = familyRoot(run, byId).task.id;
    families.set(rootId, [...(families.get(rootId) ?? []), run]);
  }

  const buckets: Record<RunSectionKey, Run[]> = { attention: [], running: [], queued: [], ended: [] };
  for (const family of families.values()) {
    let key: RunSectionKey = 'ended';
    for (const run of family) {
      const section = SECTION_OF_STAGE[run.stage];
      if (SECTION_RANK[section] < SECTION_RANK[key]) {
        key = section;
      }
    }
    if (key === 'ended' && !family.some((run) => inWindow(run, opts.window, opts.now))) {
      continue;
    }
    buckets[key].push(...family);
  }

  const sections: RunSection[] = [];
  for (const key of SECTION_ORDER) {
    if (buckets[key].length > 0) {
      sections.push({ key, rows: orderRunsAsTree(buckets[key]) });
    }
  }
  return sections;
}

export interface RunTimes {
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
}

export function runTimes(task: ClusterTask, exitedAt: number | undefined, now: number): RunTimes {
  const startedAt = toMs(task.workerStartedAt) ?? toMs(task.startedAt);
  const endedAt = toMs(task.completedAt) ?? exitedAt ?? null;
  const durationMs = startedAt === null ? null : (endedAt ?? now) - startedAt;
  return { startedAt, endedAt, durationMs };
}

/** The template a run will use: the one chosen, else the project's default (the empty choice means "auto"). */
export function resolveTemplate(
  input: { project: string; template?: string },
  templates: Pick<ClusterTemplatesResponse, 'projectDefaults'> | null,
): string | undefined {
  return input.template || templates?.projectDefaults[input.project] || undefined;
}

/** A planner that was dispatched without a ticket has nowhere to write its plan and result back. */
export function needsPlannerTicket(role: string | undefined, ticketId: string | undefined): boolean {
  return role === 'planner' && !ticketId;
}

export function plannerTicketDraft(description: string, project: string, template: string): TicketCreateBody {
  return { title: runTitle(description), status: 'ready', project, template, body: description };
}

/**
 * What the composer opens with: the remembered project if it still exists, else the configured
 * default; the remembered template only follows a remembered project that hit.
 */
export function composerDefaults(
  saved: { project?: string; template?: string },
  projects: string[],
  defaultAlias: string | undefined,
  projectDefaults: Record<string, string>,
): { project: string; template: string } {
  const savedProject = saved.project && projects.includes(saved.project) ? saved.project : undefined;
  const project =
    savedProject ?? (defaultAlias && projects.includes(defaultAlias) ? defaultAlias : (projects[0] ?? ''));
  const template = savedProject ? (saved.template ?? projectDefaults[project] ?? '') : (projectDefaults[project] ?? '');
  return { project, template };
}

/** Files a terminal report listed; the column holds a JSON array. */
export function parseFiles(filesModified: string | undefined): string[] {
  if (!filesModified) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(filesModified);
    return Array.isArray(parsed) ? parsed.map(String) : [filesModified];
  } catch {
    return [filesModified];
  }
}

export interface MessageAvailability {
  enabled: boolean;
  hint: string;
}

export const MESSAGE_ENABLED_HINT = 'worker 下一次调用 hub 时收到这条消息。';

/** A message reaches a worker only while one is running the task. */
export function messageAvailability(task: Pick<ClusterTask, 'status'>): MessageAvailability {
  switch (task.status) {
    case 'running':
      return { enabled: true, hint: MESSAGE_ENABLED_HINT };
    case 'pending':
    case 'claimed':
      return { enabled: false, hint: '运行还没开始，worker 启动后才能发消息。' };
    default:
      return { enabled: false, hint: '运行已结束，重新提交或续跑。' };
  }
}
