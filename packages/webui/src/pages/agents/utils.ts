import type { AgentTaskEvent, AgentTaskRecord, AgentTaskStatus } from '../../types';

/**
 * Tailwind class set for a task status badge. Same vocabulary as cluster task and
 * ticket statuses (running = blue, completed = green) so the pages read alike.
 */
export function agentStatusBadgeClass(status: AgentTaskStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300';
    case 'running':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300';
    case 'failed':
      return 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300';
    default:
      // pending
      return 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  }
}

const STATUS_LABELS: Record<AgentTaskStatus, string> = {
  pending: '排队中',
  running: '运行中',
  completed: '完成',
  failed: '失败',
};

export function agentStatusLabel(status: AgentTaskStatus): string {
  return STATUS_LABELS[status] ?? status;
}

const EVENT_LABELS: Record<AgentTaskEvent['kind'], string> = {
  created: '创建',
  running: '开始',
  progress: '进度',
  completed: '完成',
  failed: '失败',
};

export function agentEventLabel(kind: AgentTaskEvent['kind']): string {
  return EVENT_LABELS[kind] ?? kind;
}

/** `HH:MM:SS` for a timeline entry. */
export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour12: false });
}

/** Local date + time, dropping the year for current-year stamps to keep rows compact. */
export function formatTimestamp(iso: string | undefined): string {
  if (!iso) {
    return '-';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString(undefined, {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * How long a task ran. A finished task measures start to finish; a running one measures
 * from its start to now, so the row keeps counting while it works.
 */
export function formatDuration(task: AgentTaskRecord, now: number = Date.now()): string {
  const start = task.startedAt ? new Date(task.startedAt).getTime() : undefined;
  if (start === undefined) {
    return '-';
  }
  const end = task.finishedAt ? new Date(task.finishedAt).getTime() : now;
  return formatElapsed(end - start);
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** One line naming who asked, for the detail header. */
export function describeRequester(task: AgentTaskRecord): string {
  const { type, id, userId } = task.requestedBy;
  if (type === 'group') {
    return userId ? `群 ${id} · 用户 ${userId}` : `群 ${id}`;
  }
  return `用户 ${id}`;
}
