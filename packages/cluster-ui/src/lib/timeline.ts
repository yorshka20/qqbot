import type {
  ClusterEventEntry,
  ClusterHelpRequest,
  ClusterTask,
  ReportEventData,
  ReportEventDetail,
} from '@qqbot/api-types';
import { toMs } from './time';

export type EndState = 'completed' | 'failed' | 'blocked' | 'cancelled';

export interface ReportStats {
  linesAdded?: number;
  linesRemoved?: number;
  testsRan?: number;
  testsPassed?: number;
}

const STAT_KEYS = ['linesAdded', 'linesRemoved', 'testsRan', 'testsPassed'] as const;

/** undefined when a report carried no numbers at all, so the row is skipped. */
export function reportStats(detail: ReportEventDetail | undefined): ReportStats | undefined {
  const stats: ReportStats = {};
  for (const key of STAT_KEYS) {
    const value = detail?.[key];
    if (typeof value === 'number') {
      stats[key] = value;
    }
  }
  return Object.keys(stats).length > 0 ? stats : undefined;
}

export type TimelineNode =
  | { kind: 'note'; id: string; at: number; text: string }
  | {
      kind: 'progress';
      id: string;
      at: number;
      summary: string;
      nextSteps?: string;
      files: string[];
      stats?: ReportStats;
      lockedFiles: number;
    }
  | {
      kind: 'question';
      id: string;
      at: number;
      askId: string;
      question: string;
      context?: string;
      options?: string[];
      pending: boolean;
      answer?: string;
    }
  | { kind: 'end'; id: string; at: number; state: EndState; summary?: string; stats?: ReportStats };

export interface TimelineInput {
  task: ClusterTask;
  events: ClusterEventEntry[];
  /** The pending requests; a `help_request` event that is not among them has been answered. */
  help: ClusterHelpRequest[];
  answers: ReadonlyMap<string, string>;
  workerExitedAt?: number;
}

const END_STATE: Partial<Record<ClusterEventEntry['type'], EndState>> = {
  task_completed: 'completed',
  task_failed: 'failed',
  task_blocked: 'blocked',
};

function lockedFileCount(event: ClusterEventEntry): number {
  const files = event.data.files;
  return Array.isArray(files) ? files.length : 1;
}

function eventNode(event: ClusterEventEntry, input: TimelineInput): TimelineNode | null {
  const id = `e${event.seq}`;
  const at = event.timestamp;
  const end = END_STATE[event.type];
  if (end) {
    const report = event.data as ReportEventData;
    return {
      kind: 'end',
      id,
      at,
      state: end,
      summary: report.summary?.trim() || report.detail?.error,
      stats: reportStats(report.detail),
    };
  }
  switch (event.type) {
    case 'worker_progress': {
      const report = event.data as ReportEventData;
      return {
        kind: 'progress',
        id,
        at,
        summary: report.summary?.trim() || '在工作',
        nextSteps: report.nextSteps?.trim() || undefined,
        files: Array.isArray(report.filesModified) ? report.filesModified.map(String) : [],
        stats: reportStats(report.detail),
        lockedFiles: 0,
      };
    }
    case 'help_request': {
      const askId = String(event.data.askId ?? '');
      const pending = input.help.find((h) => h.id === askId);
      return {
        kind: 'question',
        id,
        at,
        askId,
        question: pending?.question ?? String(event.data.question ?? ''),
        context: pending?.context,
        options: pending?.options,
        pending: pending !== undefined,
        answer: input.answers.get(askId),
      };
    }
    case 'directive':
      return { kind: 'note', id, at, text: `指令 · ${String(event.data.content ?? '')}` };
    case 'answer':
      return { kind: 'note', id, at, text: `回答 · ${String(event.data.content ?? '')}` };
    case 'message':
      return event.data.kind === 'plan_written'
        ? { kind: 'note', id, at, text: `写了计划 · ${String(event.data.path ?? '')}` }
        : { kind: 'note', id, at, text: `消息 · ${String(event.data.content ?? '')}` };
    default:
      return null;
  }
}

/**
 * One time-ordered stream out of the run's event log and the task record. The start and exit
 * nodes come from the record: `worker_joined` / `worker_left` are logged without a task id, so
 * the per-task event route never returns them.
 */
export function buildTimeline(input: TimelineInput): TimelineNode[] {
  const { task, workerExitedAt } = input;
  const nodes: TimelineNode[] = [];

  const created = toMs(task.createdAt);
  if (created !== null) {
    nodes.push({ kind: 'note', id: 'submitted', at: created, text: '提交' });
  }
  const started = toMs(task.workerStartedAt) ?? toMs(task.startedAt);
  if (started !== null) {
    const who = [task.workerId, task.workerPid && `pid ${task.workerPid}`].filter(Boolean).join(' · ');
    nodes.push({ kind: 'note', id: 'started', at: started, text: who ? `启动 ${who}` : '启动' });
  }

  const ordered = [...input.events].sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);
  let unattachedLocks = 0;
  let lastProgress: Extract<TimelineNode, { kind: 'progress' }> | null = null;
  for (const event of ordered) {
    if (event.type === 'lock_acquired') {
      if (lastProgress) {
        lastProgress.lockedFiles += lockedFileCount(event);
      } else {
        unattachedLocks += lockedFileCount(event);
      }
      continue;
    }
    const node = eventNode(event, input);
    if (!node) {
      continue;
    }
    if (node.kind === 'progress') {
      node.lockedFiles = unattachedLocks;
      unattachedLocks = 0;
      lastProgress = node;
    }
    nodes.push(node);
  }

  if (workerExitedAt !== undefined) {
    nodes.push({ kind: 'note', id: 'exited', at: workerExitedAt, text: 'worker 退出' });
  }

  // A kill, a timeout or a worker that died without reporting leaves no `task_*` event.
  const finished = toMs(task.completedAt);
  const terminal =
    task.status === 'completed' || task.status === 'failed' || task.status === 'blocked' || task.status === 'cancelled';
  if (terminal && finished !== null && !nodes.some((n) => n.kind === 'end')) {
    nodes.push({ kind: 'end', id: 'end', at: finished, state: task.status as EndState, summary: task.error });
  }

  return nodes.sort((a, b) => a.at - b.at);
}

export interface RulerGap {
  /** One tick per whole minute of the gap. */
  ticks: number;
  /** Set instead of ticks when the gap is too long to draw. */
  foldedMinutes: number | null;
}

const MAX_RULER_MINUTES = 10;

/** Design §4: a minute per tick, and past ten minutes the gap folds into "…23 分钟…". */
export function rulerGap(fromMs: number, toMsValue: number): RulerGap {
  const minutes = Math.max(0, Math.floor((toMsValue - fromMs) / 60_000));
  return minutes > MAX_RULER_MINUTES ? { ticks: 0, foldedMinutes: minutes } : { ticks: minutes, foldedMinutes: null };
}

/** The ruler's tick count read back as a label, e.g. "3 分钟". */
export function rulerMinutesLabel(ticks: number): string {
  return `${ticks} 分钟`;
}

export type TimelineItem = { fold: false; node: TimelineNode } | { fold: true; id: string; nodes: TimelineNode[] };

const HEAD_NODES = 2;
const TAIL_NODES = 20;

/**
 * A run that reports often would push the log and the session off the page. The start and the
 * recent end stay, the middle folds; a worker's progress report and a question still waiting
 * are never folded away.
 */
export function foldTimeline(nodes: TimelineNode[]): TimelineItem[] {
  const tailStart = nodes.length - TAIL_NODES;
  const items: TimelineItem[] = [];
  let hidden: TimelineNode[] = [];
  const flush = () => {
    if (hidden.length > 0) {
      items.push({ fold: true, id: `fold:${hidden[0].id}`, nodes: hidden });
      hidden = [];
    }
  };
  nodes.forEach((node, index) => {
    const kept =
      index < HEAD_NODES ||
      index >= tailStart ||
      node.kind === 'progress' ||
      (node.kind === 'question' && node.pending);
    if (kept) {
      flush();
      items.push({ fold: false, node });
    } else {
      hidden.push(node);
    }
  });
  return items;
}
