import type { Run } from '../lib/runs';
import { STAGE_LABEL, STAGE_TONE, stageRank } from '../lib/stage';
import { formatAgo, formatSpan } from '../lib/time';
import { STAGE_ICON, StatePill } from '../ui/StatePill';
import { StatusBar } from '../ui/StatusBar';

export function runSpanLabel(run: Run, now: number): string {
  const ended = stageRank(run.stage) >= stageRank('done') || run.stage === 'review';
  return ended ? formatAgo(now - run.since) : formatSpan(now - run.since);
}

export function RunRow({
  run,
  href,
  index,
  now,
  selected,
  cursor,
}: {
  run: Run;
  href: string;
  index: number;
  now: number;
  selected: boolean;
  cursor: boolean;
}) {
  const tone = STAGE_TONE[run.stage];
  return (
    <a
      href={href}
      data-row={index}
      className={`relative block border-b border-line/60 px-4 py-3 pl-5 hover:bg-surface-2 ${
        selected || cursor ? 'bg-surface-2' : ''
      }`}
    >
      <StatusBar tone={tone} active={selected} />
      <div className="flex items-center justify-between gap-2">
        <StatePill
          tone={tone}
          label={STAGE_LABEL[run.stage]}
          icon={STAGE_ICON[run.stage]}
          breathing={run.stage === 'running'}
        />
        <span className="text-13 text-ink-muted">{runSpanLabel(run, now)}</span>
      </div>
      <div className={`truncate text-16 ${selected ? 'font-medium' : ''}`}>{run.title}</div>
      <div className="truncate text-14 text-ink-muted">
        {[run.task.parentTaskId && '子运行', run.task.project, run.task.workerTemplate].filter(Boolean).join(' · ')}
      </div>
    </a>
  );
}
