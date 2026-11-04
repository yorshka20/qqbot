import type { ReactNode } from 'react';
import { type Run, runBody } from '../lib/runs';
import { STAGE_LABEL, STAGE_TONE, stageRank } from '../lib/stage';
import { formatAgo, formatSpan } from '../lib/time';
import { STAGE_ICON, StatePill } from '../ui/StatePill';
import { StatusBar } from '../ui/StatusBar';

export function runSpanLabel(run: Run, now: number): string {
  const ended = stageRank(run.stage) >= stageRank('done') || run.stage === 'review';
  return ended ? formatAgo(now - run.since) : formatSpan(now - run.since);
}

const INDENT_STEP = 24;
const MAX_INDENT_DEPTH = 2;

function RoleTag({ children }: { children: ReactNode }) {
  return <span className="shrink-0 rounded-ui bg-line/60 px-1.5 py-0.5 text-12 text-ink-muted">{children}</span>;
}

export function RunRow({
  run,
  href,
  index,
  now,
  selected,
  cursor,
  depth,
  lastChild,
  childRuns,
}: {
  run: Run;
  href: string;
  index: number;
  now: number;
  selected: boolean;
  cursor: boolean;
  depth: number;
  lastChild: boolean;
  childRuns: number;
}) {
  const tone = STAGE_TONE[run.stage];
  const level = Math.min(depth, MAX_INDENT_DEPTH);
  const railLeft = 12 + (level - 1) * INDENT_STEP;
  return (
    <a
      href={href}
      data-row={index}
      style={level > 0 ? { paddingLeft: 20 + level * INDENT_STEP } : undefined}
      className={`relative block border-b border-line/60 py-3 pr-4 hover:bg-surface-2 ${level > 0 ? '' : 'pl-5'} ${
        selected || cursor ? 'bg-surface-2' : ''
      }`}
    >
      <StatusBar tone={tone} active={selected} />
      {level > 0 && (
        <>
          <span
            aria-hidden
            className={`absolute top-0 w-px bg-line ${lastChild ? 'h-[1.4rem]' : 'bottom-0'}`}
            style={{ left: railLeft }}
          />
          <span aria-hidden className="absolute top-[1.4rem] h-px w-3 bg-line" style={{ left: railLeft }} />
        </>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <StatePill
            tone={tone}
            label={STAGE_LABEL[run.stage]}
            icon={STAGE_ICON[run.stage]}
            breathing={run.stage === 'running'}
          />
          {childRuns > 0 && <RoleTag>规划器 · 派生 {childRuns}</RoleTag>}
          {depth > 0 && <RoleTag>执行器</RoleTag>}
        </span>
        <span className="shrink-0 text-13 text-ink-muted">{runSpanLabel(run, now)}</span>
      </div>
      <div className={`truncate text-16 ${selected ? 'font-medium' : ''}`} title={runBody(run.task.description)}>
        {run.title}
      </div>
      <div className="flex min-w-0 items-baseline gap-2 text-14 text-ink-muted">
        <span className="truncate">{[run.task.project, run.task.workerTemplate].filter(Boolean).join(' · ')}</span>
        {run.task.model && <span className="ml-auto shrink-0 truncate font-mono text-13">{run.task.model}</span>}
      </div>
    </a>
  );
}
