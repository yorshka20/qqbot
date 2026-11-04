import type { ClusterEventEntry, ClusterHelpRequest, ClusterTask, ReportEventData } from '@qqbot/api-types';
import { parseFiles } from './runs';
import { toMs } from './time';
import { type EndState, lockedFileCount, type ReportStats, reportStats } from './timeline';
import { parseTranscript } from './transcript';

export type ConversationEntry =
  | { kind: 'owner'; id: string; at: number; from: string; text: string }
  | {
      kind: 'report';
      id: string;
      at: number;
      summary: string;
      nextSteps?: string;
      files: string[];
      stats?: ReportStats;
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
      answeredBy?: string;
      answeredAt?: number;
    }
  | {
      kind: 'spawn';
      id: string;
      at: number;
      childTaskId: string;
      description: string;
      template?: string;
      model?: string;
    }
  | {
      kind: 'end';
      id: string;
      at: number;
      state: EndState;
      summary?: string;
      reason?: string;
      files: string[];
      stats?: ReportStats;
    }
  | { kind: 'system'; id: string; at: number; seq?: number; text: string };

export interface ConversationInput {
  task: ClusterTask;
  events: ClusterEventEntry[];
  help: ClusterHelpRequest[];
  helpHistory: ClusterHelpRequest[];
  workerExitedAt?: number;
  children: ClusterTask[];
  output?: string;
}

/** The reason a run ended badly, best source first. The exit code alone says nothing. */
export function failureReason(input: {
  reportError?: string;
  output?: string;
  taskError?: string;
}): string | undefined {
  const reported = input.reportError?.trim();
  if (reported) {
    return reported;
  }
  const entries = input.output ? parseTranscript(input.output) : null;
  const failedResult = entries?.filter((entry) => entry.kind === 'result' && entry.failed === true).at(-1);
  const fromOutput = failedResult?.body?.trim();
  return fromOutput || input.taskError?.trim() || undefined;
}

const END_STATE: Partial<Record<ClusterEventEntry['type'], EndState>> = {
  task_completed: 'completed',
  task_failed: 'failed',
  task_blocked: 'blocked',
};

const TERMINAL: ReadonlySet<ClusterTask['status']> = new Set(['completed', 'failed', 'blocked', 'cancelled']);

/**
 * The run as a conversation: what the owner said, what the worker reported, what it asked, and
 * how it ended — one time-ordered stream built from the event log plus the task record.
 */
export function buildConversation(input: ConversationInput): ConversationEntry[] {
  const { task, events, help, helpHistory, workerExitedAt, children, output } = input;
  const files = parseFiles(task.filesModified);
  const entries: ConversationEntry[] = [];

  const submitted = toMs(task.createdAt);
  if (submitted !== null) {
    entries.push({ kind: 'system', id: 'submitted', at: submitted, text: '提交' });
  }
  const started = toMs(task.workerStartedAt) ?? toMs(task.startedAt);
  if (started !== null) {
    const who = [task.workerId, task.workerPid && `pid ${task.workerPid}`].filter(Boolean).join(' · ');
    entries.push({ kind: 'system', id: 'started', at: started, text: who ? `启动 ${who}` : '启动' });
  }

  const historyById = new Map(helpHistory.map((request) => [request.id, request]));
  const pendingIds = new Set(help.map((request) => request.id));
  // An answer whose `help_request` fell outside the event window still needs a row to hang on.
  const askedIds = new Set(
    events.filter((event) => event.type === 'help_request').map((event) => String(event.data.askId ?? '')),
  );

  for (const event of events) {
    const id = `e${event.seq}`;
    const at = event.timestamp;
    const end = END_STATE[event.type];
    if (end) {
      const report = event.data as ReportEventData;
      entries.push({
        kind: 'end',
        id,
        at,
        state: end,
        summary: report.summary?.trim() || report.detail?.error,
        reason:
          end === 'failed' || end === 'blocked'
            ? failureReason({
                reportError: report.detail?.error ?? report.detail?.blockReason,
                output,
                taskError: task.error,
              })
            : undefined,
        files,
        stats: reportStats(report.detail),
      });
      continue;
    }
    switch (event.type) {
      case 'worker_progress': {
        const report = event.data as ReportEventData;
        entries.push({
          kind: 'report',
          id,
          at,
          summary: report.summary?.trim() || '在工作',
          nextSteps: report.nextSteps?.trim() || undefined,
          files: Array.isArray(report.filesModified) ? report.filesModified.map(String) : [],
          stats: reportStats(report.detail),
        });
        break;
      }
      case 'help_request': {
        const askId = String(event.data.askId ?? '');
        const history = historyById.get(askId);
        entries.push({
          kind: 'question',
          id,
          at,
          askId,
          question: history?.question ?? String(event.data.question ?? ''),
          context: history?.context,
          options: history?.options,
          pending: pendingIds.has(askId),
          answer: history?.answer,
          answeredBy: history?.answeredBy,
          answeredAt: toMs(history?.answeredAt) ?? undefined,
        });
        break;
      }
      case 'answer': {
        const askId = String(event.data.askId ?? '');
        if (askedIds.has(askId)) {
          break;
        }
        entries.push({
          kind: 'question',
          id,
          at,
          askId,
          question: String(event.data.question ?? ''),
          pending: false,
          answer: String(event.data.answer ?? ''),
          answeredBy: event.sourceWorkerId,
          answeredAt: at,
        });
        break;
      }
      case 'directive':
        entries.push({ kind: 'owner', id, at, from: event.sourceWorkerId, text: String(event.data.text ?? '') });
        break;
      case 'lock_acquired':
        entries.push({ kind: 'system', id, at, seq: event.seq, text: `锁定 ${lockedFileCount(event)} 个文件` });
        break;
      case 'message':
        entries.push({
          kind: 'system',
          id,
          at,
          seq: event.seq,
          text:
            event.data.kind === 'plan_written'
              ? `写了计划 · ${String(event.data.path ?? '')}`
              : `消息 · ${String(event.data.content ?? event.data.text ?? '')}`,
        });
        break;
      default:
        break;
    }
  }

  const spawned = new Set<string>();
  for (const child of children) {
    const at = toMs(child.createdAt);
    if (at === null || spawned.has(child.id)) {
      continue;
    }
    spawned.add(child.id);
    entries.push({
      kind: 'spawn',
      id: `spawn:${child.id}`,
      at,
      childTaskId: child.id,
      description: child.description,
      template: child.workerTemplate,
      model: child.model,
    });
  }

  if (workerExitedAt !== undefined) {
    entries.push({ kind: 'system', id: 'exited', at: workerExitedAt, text: 'worker 退出' });
  }

  // A kill, a timeout or a worker that died without reporting leaves no `task_*` event.
  const finished = toMs(task.completedAt);
  if (TERMINAL.has(task.status) && finished !== null && !entries.some((entry) => entry.kind === 'end')) {
    entries.push({
      kind: 'end',
      id: 'end',
      at: finished,
      state: task.status as EndState,
      summary: task.diffSummary ?? task.error,
      reason:
        task.status === 'failed' || task.status === 'blocked'
          ? failureReason({ output, taskError: task.error })
          : undefined,
      files,
    });
  }

  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.at - b.entry.at || a.index - b.index)
    .map(({ entry }) => entry);
}

const HEAD_ENTRIES = 2;
const TAIL_ENTRIES = 8;

export type ConversationItem =
  | { fold: false; entry: ConversationEntry }
  | { fold: true; id: string; entries: ConversationEntry[] };

/**
 * A long run keeps its first and last entries and folds the middle; a question still waiting
 * is never folded away.
 */
export function foldConversation(entries: ConversationEntry[]): ConversationItem[] {
  const tailStart = entries.length - TAIL_ENTRIES;
  const items: ConversationItem[] = [];
  let hidden: ConversationEntry[] = [];
  const flush = () => {
    if (hidden.length > 0) {
      items.push({ fold: true, id: `fold:${hidden[0].id}`, entries: hidden });
      hidden = [];
    }
  };
  entries.forEach((entry, index) => {
    if (index < HEAD_ENTRIES || index >= tailStart || (entry.kind === 'question' && entry.pending)) {
      flush();
      items.push({ fold: false, entry });
    } else {
      hidden.push(entry);
    }
  });
  flush();
  return items;
}
