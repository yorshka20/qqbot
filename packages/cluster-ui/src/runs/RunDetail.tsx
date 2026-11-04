import type { ClusterTask, ClusterTaskDetail } from '@qqbot/api-types';
import { ArrowLeft, CornerLeftUp, Pin, PinOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { acknowledgeClusterTask, killClusterTask } from '../api';
import { useCluster } from '../app/ClusterData';
import { navigate, type Route, routeHref, withRoute } from '../app/route';
import { readRunView, rememberRunView } from '../lib/memory';
import { RUN_VIEW_LABEL, RUN_VIEWS, type Run, type RunView, runTimes, runTitle } from '../lib/runs';
import { isLive, STAGE_LABEL, STAGE_TONE, stageOfStatus, TONE_TEXT } from '../lib/stage';
import { formatSpan } from '../lib/time';
import { useNow } from '../lib/useNow';
import { Button, ConfirmButton } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { STAGE_ICON, StatePill } from '../ui/StatePill';
import { ConversationView } from './ConversationView';
import { DescriptionSection } from './DescriptionSection';
import { LogPane } from './LogPane';
import { ResultSection } from './ResultSection';
import { ModelName, RunFactsLine } from './RunFacts';
import { SessionSection } from './SessionSection';
import { retryRun } from './submitRun';
import { useRunDetail } from './useRunDetail';

function Actions({
  run,
  task,
  onAnswer,
  pin,
}: {
  run: Run;
  task: ClusterTaskDetail;
  onAnswer: () => void;
  pin: { href: string; pinned: boolean };
}) {
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
        <Button variant="solid" onClick={onAnswer}>
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
      <a
        href={pin.href}
        className="hidden items-center gap-1 rounded-ui px-3 py-1.5 text-14 font-medium hover:bg-surface-2 xl:inline-flex"
      >
        {pin.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
        {pin.pinned ? '取消钉住' : '钉住并排看'}
      </a>
      {error && <p className="w-full text-13 text-failed">{error}</p>}
    </div>
  );
}

function ChildRuns({ spawned, runs, route }: { spawned: ClusterTask[]; runs: Run[]; route: Route }) {
  if (spawned.length === 0) {
    return null;
  }
  return (
    <div className="mt-4">
      <h2 className="mb-1 text-14 font-medium text-ink-muted">派生了 {spawned.length} 条子运行</h2>
      <ul className="flex flex-col gap-1">
        {spawned.map((child) => {
          const stage = runs.find((r) => r.task.id === child.id)?.stage ?? stageOfStatus(child.status);
          return (
            <li key={child.id} className="flex min-w-0 gap-2 text-15">
              <span className={`shrink-0 ${TONE_TEXT[STAGE_TONE[stage]]}`}>{STAGE_LABEL[stage]}</span>
              <a href={withRoute(route, { runId: child.id })} className="truncate underline">
                {runTitle(child.description)}
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ViewTabs({ view, onChange }: { view: RunView; onChange: (view: RunView) => void }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 border-b border-line">
      {RUN_VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={view === v}
          onClick={() => onChange(v)}
          className={`-mb-px border-b-2 px-3 py-1.5 text-14 ${
            view === v ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-muted hover:text-ink'
          }`}
        >
          {RUN_VIEW_LABEL[v]}
        </button>
      ))}
    </div>
  );
}

export function RunDetail({ runId, route, pinned = false }: { runId: string; route: Route; pinned?: boolean }) {
  const { runs, workerExits } = useCluster();
  const { task: detail, events, failed } = useRunDetail(runId);
  const now = useNow();
  const article = useRef<HTMLElement>(null);
  const [view, setView] = useState<RunView>(() => route.view ?? readRunView());
  const [answerRequests, setAnswerRequests] = useState(0);

  const routeView = route.view;
  useEffect(() => {
    if (routeView) {
      setView(routeView);
    }
  }, [routeView]);

  // The answer box only exists while the conversation tab is showing.
  useEffect(() => {
    if (answerRequests > 0) {
      article.current?.querySelector<HTMLElement>('[data-answer-box]')?.focus();
    }
  }, [answerRequests]);

  const chooseView = (next: RunView) => {
    setView(next);
    rememberRunView(next);
  };

  const run = runs.find((r) => r.task.id === runId);
  const task = detail ?? run?.task ?? null;

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
  const exitedAt = task.workerId ? workerExits.get(task.workerId) : undefined;
  const { durationMs } = runTimes(task, exitedAt, now);
  const children = detail?.children ?? runs.filter((r) => r.task.parentTaskId === task.id).map((r) => r.task);
  const parent = task.parentTaskId ? runs.find((r) => r.task.id === task.parentTaskId) : undefined;
  const ticketId = run?.ticketId;
  const pin = pinned
    ? { href: withRoute(route, { pin: null }), pinned: true }
    : { href: withRoute(route, { pin: runId, runId: null }), pinned: false };

  const requestAnswer = () => {
    chooseView('chat');
    setAnswerRequests((n) => n + 1);
  };

  return (
    <article ref={article} className={shell}>
      <div className="w-full max-w-measure p-5 md:p-8">
        {!pinned && (
          <a href={backHref} className="mb-3 inline-flex items-center gap-1 text-13 text-ink-muted md:hidden">
            <ArrowLeft className="size-4" />
            返回
          </a>
        )}
        <header className="mb-5">
          {task.parentTaskId && (
            <a
              href={withRoute(route, { runId: task.parentTaskId })}
              className="mb-1 inline-flex max-w-full items-center gap-1 text-14 text-ink-muted hover:text-ink"
            >
              <CornerLeftUp className="size-4 shrink-0" />
              <span className="truncate underline">{parent?.title ?? '上级运行'}</span>
            </a>
          )}
          <h1 className="min-w-0 text-24 font-medium tracking-tight break-words">
            {run?.title ?? runTitle(task.description)}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-14 text-ink-muted">
            <span>{[task.project, task.workerTemplate].filter(Boolean).join(' · ')}</span>
            <ModelName id={task.model} />
            {stage && (
              <StatePill
                tone={STAGE_TONE[stage]}
                label={STAGE_LABEL[stage]}
                icon={STAGE_ICON[stage]}
                breathing={stage === 'running'}
              />
            )}
            <span>
              {durationMs !== null
                ? `${live ? '已跑' : '跑了'} ${formatSpan(durationMs)}`
                : `等了 ${formatSpan(now - (run?.since ?? now))}`}
            </span>
            {ticketId && (
              <a href={withRoute(route, { ticket: ticketId })} className="font-mono text-13 text-ink underline">
                ticket {ticketId}
              </a>
            )}
          </div>
          <RunFactsLine task={task} exitedAt={exitedAt} now={now} className="mt-1" />
          <ChildRuns spawned={children} runs={runs} route={route} />
          <div className="mt-4">
            <DescriptionSection description={task.description} />
          </div>
          {run && (
            <div>
              <Actions run={run} task={task} onAnswer={requestAnswer} pin={pin} />
            </div>
          )}
        </header>

        <ViewTabs view={view} onChange={chooseView} />
        {view === 'chat' && <ConversationView task={task} events={events} now={now} />}
        {view === 'log' && <LogPane taskId={task.id} live={live} logPath={task.logPath} />}
        {view === 'result' && <ResultSection task={task} ticketId={ticketId} route={route} live={live} />}
        <div className="mt-8">
          <SessionSection task={task} />
        </div>
      </div>
    </article>
  );
}
