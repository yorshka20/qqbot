import type { Run } from '../lib/runs';
import { STAGE_LABEL, STAGE_TONE, stageRank, TONE_BG, TONE_TEXT } from '../lib/stage';
import { formatAgo, formatSpan } from '../lib/time';
import { StatusDot } from '../ui/StatusDot';

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
      className={`relative block px-4 py-2.5 hover:bg-surface-2 ${selected || cursor ? 'bg-surface-2' : ''}`}
    >
      {selected && <span className={`absolute inset-y-0 left-0 w-0.5 ${TONE_BG[tone]}`} />}
      <div className={`flex items-center gap-1.5 text-15 font-medium ${TONE_TEXT[tone]}`}>
        {run.stage === 'running' && <StatusDot tone="working" breathing />}
        <span>
          {STAGE_LABEL[run.stage]} · {runSpanLabel(run, now)}
        </span>
      </div>
      <div className="truncate text-15">{run.title}</div>
      <div className="truncate text-13 text-ink-muted">
        {[run.task.parentTaskId && '子运行', run.task.project, run.task.workerTemplate].filter(Boolean).join(' · ')}
      </div>
    </a>
  );
}
