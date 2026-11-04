import type { ClusterTask } from '@qqbot/api-types';
import { modelDisplayName } from '../lib/model';
import { runTimes } from '../lib/runs';
import { formatClock, formatSpan } from '../lib/time';
import { usageFacts } from '../lib/usage';

export function ModelName({ id, className = '' }: { id: string | undefined; className?: string }) {
  return (
    <span title={id} className={className}>
      {modelDisplayName(id)}
    </span>
  );
}

function timeFacts(task: ClusterTask, exitedAt: number | undefined, now: number): string {
  const { startedAt, endedAt, durationMs } = runTimes(task, exitedAt, now);
  if (startedAt === null) {
    return '未开始';
  }
  const parts = [`开始 ${formatClock(startedAt, now)}`, `跑了 ${formatSpan(durationMs ?? 0)}`];
  if (endedAt !== null) {
    parts.push(`结束 ${formatClock(endedAt, now)}`);
  }
  return parts.join(' · ');
}

function usageLine(task: ClusterTask): string {
  if (!task.usage) {
    return '用量未知';
  }
  const facts = usageFacts(task.usage);
  const parts = [`context ${facts.context}`, `入 ${facts.input}`, `出 ${facts.output}`, `${facts.turns} 轮`];
  if (facts.cost) {
    parts.push(facts.cost);
  }
  return parts.join(' · ');
}

/** When the run started, how long it ran and what it used: the two lines every run surface carries. */
export function RunFactsLine({
  task,
  exitedAt,
  now,
  className = '',
}: {
  task: ClusterTask;
  exitedAt?: number;
  now: number;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col text-13 text-ink-muted ${className}`}>
      <span className="truncate">{timeFacts(task, exitedAt, now)}</span>
      <span className="truncate">{usageLine(task)}</span>
    </div>
  );
}
