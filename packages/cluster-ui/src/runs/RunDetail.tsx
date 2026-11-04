import type { ClusterTaskDetail } from '@qqbot/api-types';
import { ArrowLeft, CornerLeftUp, Pin, PinOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { acknowledgeClusterTask, killClusterTask } from '../api';
import { useCluster } from '../app/ClusterData';
import { navigate, type Route, routeHref, withRoute } from '../app/route';
import { answersOf } from '../lib/inbox';
import { type Run, runTitle } from '../lib/runs';
import { isLive, STAGE_LABEL, STAGE_TONE, TONE_TEXT } from '../lib/stage';
import { formatClock, formatSpan, toMs } from '../lib/time';
import { buildTimeline } from '../lib/timeline';
import { useNow } from '../lib/useNow';
import { Button, ConfirmButton } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Section } from '../ui/Section';
import { STAGE_ICON, StatePill } from '../ui/StatePill';
import { DescriptionSection } from './DescriptionSection';
import { LogPane } from './LogPane';
import { ResultSection } from './ResultSection';
import { SessionSection } from './SessionSection';
import { retryRun } from './submitRun';
import { Timeline } from './Timeline';
import { useRunDetail } from './useRunDetail';

function elapsed(task: ClusterTaskDetail, now: number): number | null {
  const started = toMs(task.workerStartedAt) ?? toMs(task.startedAt);
  return started === null ? null : (toMs(task.completedAt) ?? now) - started;
}

function Actions({ run, task }: { run: Run; task: ClusterTaskDetail }) {
  const { templates, refresh } = useCluster();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const retry = () =>
    act(async () => {
      const next = await retryRun(run, templates);
      await refresh();
      navigate(routeHref({ section: 'runs', runId: next.id }));
    });

  const kill = () =>
    act(async () => {
      await killClusterTask(task.id, 'Stopped from the console');
      await refresh();
    });

  const acknowledge = () =>
    act(async () => {
      await acknowledgeClusterTask(task.id);
      await refresh();
    });

  // Reading a finished run is what clears it from the inbox; a failure needs an explicit decision.
  const requested = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `acknowledge` is rebuilt every render; the run id and stage are the trigger
  useEffect(() => {
    if (run.stage === 'review' && !requested.current.has(task.id)) {
      requested.current.add(task.id);
      void acknowledge();
    }
  }, [run.stage, task.id]);

  const live = isLive(task);
  const needsDismissal = run.stage === 'failed' || run.stage === 'blocked';

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {run.stage === 'asking' && (
        <Button variant="solid" onClick={() => document.querySelector<HTMLElement>('[data-answer-box]')?.focus()}>
          回答
        </Button>
      )}
      {!live && (
        <Button disabled={busy} onClick={retry} title="用同样的描述重新提交一条运行">
          重试这条运行
        </Button>
      )}
      {needsDismissal && (
        <Button disabled={busy} onClick={acknowledge}>
          标记已看
        </Button>
      )}
      {live && <ConfirmButton label="终止 worker" confirmLabel="确认终止" disabled={busy} onConfirm={kill} />}
      {error && <p className="w-full text-13 text-failed">{error}</p>}
    </div>
  );
}

function Facts({ task, now }: { task: ClusterTaskDetail; now: number }) {
  const started = toMs(task.workerStartedAt) ?? toMs(task.startedAt);
  const ran = elapsed(task, now);
  const rows: [string, string][] = [];
  if (task.workerId) {
    rows.push(['worker', task.workerId]);
  }
  if (task.workerPid !== undefined) {
    rows.push(['pid', String(task.workerPid)]);
  }
  if (started !== null) {
    rows.push(['开始', formatClock(started, now)]);
  }
  if (ran !== null) {
    rows.push(['已跑', formatSpan(ran)]);
  }
  if (task.model) {
    rows.push(['模型', task.model]);
  }
  if (rows.length === 0) {
    return null;
  }
  return (
    <div className="mt-4 flex shrink-0 flex-col gap-0.5 text-14 md:mt-0">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-3">
          <span className="w-12 shrink-0 text-ink-muted">{label}</span>
          <span className="min-w-0 font-mono text-13">{value}</span>
        </div>
      ))}
    </div>
  );
}

function ChildRuns({ runs, route }: { runs: Run[]; route: Route }) {
  if (runs.length === 0) {
    return null;
  }
  return (
    <Section title={`派生了 ${runs.length} 条子运行`}>
      <ul className="flex flex-col gap-1">
        {runs.map((run) => (
          <li key={run.task.id} className="flex min-w-0 gap-2 text-15">
            <span className={`shrink-0 ${TONE_TEXT[STAGE_TONE[run.stage]]}`}>{STAGE_LABEL[run.stage]}</span>
            <a href={withRoute(route, { runId: run.task.id })} className="truncate underline">
              {run.title}
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function RunDetail({ runId, route, pinned = false }: { runId: string; route: Route; pinned?: boolean }) {
  const { loaded, runs, help, helpHistory, workerExits } = useCluster();
  const { task: detail, events, failed } = useRunDetail(runId);
  const answers = useMemo(() => answersOf(helpHistory), [helpHistory]);
  const now = useNow();

  const run = runs.find((r) => r.task.id === runId);
  const task = detail ?? run?.task ?? null;

  // Until the shared load lands, every pending question would read as already answered.
  const nodes = useMemo(
    () =>
      task && loaded
        ? buildTimeline({
            task,
            events,
            help,
            answers,
            workerExitedAt: task.workerId ? workerExits.get(task.workerId) : undefined,
          })
        : [],
    [task, loaded, events, help, answers, workerExits],
  );

  const shell = `min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-surface ${pinned ? 'hidden border-l border-line xl:flex' : 'flex'}`;
  const backHref = routeHref({ section: route.section, project: route.project, stage: route.stage, pin: route.pin });

  if (!task) {
    return (
      <div className={shell}>
        <div className="p-4 md:p-6">
          <a href={backHref} className="mb-3 inline-flex items-center gap-1 text-13 text-ink-muted md:hidden">
            <ArrowLeft className="size-4" />
            返回
          </a>
          {failed && <EmptyState title="读不到这条运行。" hint="它可能已被清理，或调度已停止。" />}
        </div>
      </div>
    );
  }

  const live = isLive(task);
  const stage = run?.stage;
  const ran = elapsed(task, now);
  const closePin = withRoute(route, { pin: null });
  const children = runs.filter((r) => r.task.parentTaskId === task.id);
  const terminal = !live;
  const parent = task.parentTaskId ? runs.find((r) => r.task.id === task.parentTaskId) : undefined;

  const meta = [task.project, task.workerTemplate].filter(Boolean).join(' · ');

  return (
    <article className={shell}>
      <div className="w-full max-w-measure p-5 md:p-8">
        {!pinned && (
          <a href={backHref} className="mb-3 inline-flex items-center gap-1 text-13 text-ink-muted md:hidden">
            <ArrowLeft className="size-4" />
            返回
          </a>
        )}
        <header className="mb-5 md:flex md:items-start md:justify-between md:gap-8">
          <div className="min-w-0 flex-1">
            {task.parentTaskId && (
              <a
                href={withRoute(route, { runId: task.parentTaskId })}
                className="mb-1 inline-flex max-w-full items-center gap-1 text-14 text-ink-muted hover:text-ink"
              >
                <CornerLeftUp className="size-4 shrink-0" />
                <span className="truncate underline">{parent?.title ?? '上级运行'}</span>
              </a>
            )}
            <div className="flex items-start justify-between gap-3">
              <h1 className="min-w-0 text-24 font-medium tracking-tight break-words">
                {run?.title ?? runTitle(task.description)}
              </h1>
              {pinned ? (
                <a
                  href={closePin}
                  title="取消钉住"
                  className="hidden rounded-ui p-1 text-ink-muted hover:bg-surface-2 xl:block"
                >
                  <PinOff className="size-4" />
                </a>
              ) : (
                <a
                  href={withRoute(route, { pin: runId, runId: null })}
                  title="钉住这条运行，再开另一条"
                  className="hidden rounded-ui p-1 text-ink-muted hover:bg-surface-2 xl:block"
                >
                  <Pin className="size-4" />
                </a>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-14 text-ink-muted">
              {meta && <span>{meta}</span>}
              {stage && (
                <StatePill
                  tone={STAGE_TONE[stage]}
                  label={STAGE_LABEL[stage]}
                  icon={STAGE_ICON[stage]}
                  breathing={stage === 'running'}
                />
              )}
              {ran !== null && <span>已跑 {formatSpan(ran)}</span>}
            </div>
            {run && (
              <div className="mt-4">
                <Actions run={run} task={task} />
              </div>
            )}
          </div>
          {!pinned && <Facts task={task} now={now} />}
        </header>

        <DescriptionSection description={task.description} />

        <Section title="时间线">
          <Timeline nodes={nodes} live={live} now={now} />
        </Section>

        <LogPane taskId={task.id} live={live} logPath={task.logPath} />

        {terminal && <ResultSection task={task} ticketId={run?.ticketId} route={route} />}
        <ChildRuns runs={children} route={route} />
        <SessionSection task={task} />
      </div>
    </article>
  );
}
