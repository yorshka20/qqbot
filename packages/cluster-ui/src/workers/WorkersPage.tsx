import type { ClusterReportStatus, ClusterWorkerRegistration, ClusterWorkerRole } from '@qqbot/api-types';
import { type ReactNode, useState } from 'react';
import {
  killClusterWorker,
  pauseCluster,
  probeClusterTemplates,
  resumeCluster,
  type TemplateProbeResult,
} from '../api';
import { useCluster } from '../app/ClusterData';
import { routeHref } from '../app/route';
import type { Run } from '../lib/runs';
import { busyWorkers } from '../lib/slots';
import type { Tone } from '../lib/stage';
import { formatAgo, formatClock } from '../lib/time';
import { WORKER_STATE_LABEL, WORKER_STATE_TONE, workerState } from '../lib/topology';
import { useNow } from '../lib/useNow';
import { exitedWorkers, workerResult, workerRunFacts } from '../lib/workers';
import { ModelName, RunFactsLine } from '../runs/RunFacts';
import { Button, ConfirmButton } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Section } from '../ui/Section';
import { SkeletonRows } from '../ui/Skeleton';
import { StatePill } from '../ui/StatePill';
import { StatusDot } from '../ui/StatusDot';

const ROLE_LABEL: Record<ClusterWorkerRole, string> = {
  coder: '编码',
  planner: '规划',
  reviewer: '评审',
  custom: '自定义',
};

const REPORT_LABEL: Record<ClusterReportStatus, { label: string; tone: Tone }> = {
  working: { label: '进行中', tone: 'working' },
  completed: { label: '已完成', tone: 'done' },
  failed: { label: '失败', tone: 'failed' },
  blocked: { label: '受阻', tone: 'failed' },
};

function Meta({ children }: { children: ReactNode }) {
  return <span className="font-mono text-13 text-ink-muted">{children}</span>;
}

function WorkerCard({
  worker,
  run,
  now,
  lockCount,
  exited = false,
}: {
  worker: ClusterWorkerRegistration;
  run?: Run;
  now: number;
  lockCount: number;
  exited?: boolean;
}) {
  const { refresh, templates, workerExits } = useCluster();
  const state = exited ? 'exited' : workerState(run);
  const result = workerResult(worker);
  const tone = exited ? result.tone : WORKER_STATE_TONE[state];
  const kill = async () => {
    await killClusterWorker(worker.workerId).catch(() => {});
    await refresh();
  };
  const report = worker.lastReportStatus ? REPORT_LABEL[worker.lastReportStatus] : null;
  const hasReport = worker.lastReportSummary || worker.lastReportNextSteps || worker.lastHubReportAt !== undefined;
  const model = run?.task.model ?? templates?.templates.find((t) => t.name === worker.templateName)?.model;
  const startedAt = worker.spawnedAt ?? worker.stats.registeredAt;
  return (
    <div
      className={`flex min-w-0 flex-col gap-2 rounded-ui border border-line bg-surface-2 p-3 ${exited ? 'opacity-70' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusDot tone={tone} breathing={state === 'working'} />
        <span className="text-14 font-medium">{worker.templateName}</span>
        <ModelName id={model} className="text-14 text-ink-muted" />
        <span className="rounded-ui bg-line/60 px-1.5 py-0.5 text-12 text-ink-muted">{ROLE_LABEL[worker.role]}</span>
        <span className="text-14 text-ink-muted">{worker.project}</span>
        <span className="ml-auto flex items-center gap-2">
          {exited ? (
            worker.exitedAt !== undefined && (
              <span className="text-13 text-ink-muted">退出 {formatClock(worker.exitedAt, now)}</span>
            )
          ) : (
            <span className="text-13 text-ink-muted">{formatAgo(now - worker.lastSeen)}</span>
          )}
          <StatePill tone={tone} label={exited ? result.label : WORKER_STATE_LABEL[state]} />
        </span>
      </div>
      {run ? (
        <a href={routeHref({ section: 'runs', runId: run.task.id })} className="truncate text-16 hover:underline">
          {run.title}
        </a>
      ) : (
        <p className="text-15 text-ink-muted">{exited ? '这条运行不在已加载的范围内。' : '没有运行。'}</p>
      )}
      {worker.lastReportSummary && (
        <p className="line-clamp-2 text-14 break-words text-ink-muted">{worker.lastReportSummary}</p>
      )}
      {run ? (
        <RunFactsLine task={run.task} exitedAt={workerExits.get(worker.workerId) ?? worker.exitedAt} now={now} />
      ) : (
        <div className="text-13 text-ink-muted">
          开始 {formatClock(startedAt, now)}
          {worker.exitedAt !== undefined && ` · 结束 ${formatClock(worker.exitedAt, now)}`}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {run?.task.workerPid ? <Meta>pid {run.task.workerPid}</Meta> : null}
        {!exited && <Meta>锁 {lockCount}</Meta>}
        {worker.boundTicketId && <Meta>{worker.boundTicketId}</Meta>}
      </div>
      {hasReport && !exited && (
        <div className="flex flex-col gap-1 border-t border-line pt-2">
          <div className="flex items-center gap-2 text-12 text-ink-muted">
            <span className="font-medium">hub_report</span>
            {report && <StatePill tone={report.tone} label={report.label} />}
            {worker.lastHubReportAt !== undefined && <span>{formatAgo(now - worker.lastHubReportAt)}</span>}
            <span>· {worker.stats.totalReports} 次汇报</span>
          </div>
          {worker.lastReportNextSteps && (
            <p className="line-clamp-2 text-13 break-words text-working">next → {worker.lastReportNextSteps}</p>
          )}
        </div>
      )}
      {!exited && (
        <div className="-mb-1 flex justify-end">
          <ConfirmButton label="终止 worker" confirmLabel="确认终止" onConfirm={kill} />
        </div>
      )}
    </div>
  );
}

export function WorkersPage() {
  const { workers, workerHistory, locks, runs, templates, cluster, loaded, refresh } = useCluster();
  const now = useNow();
  const [probes, setProbes] = useState<TemplateProbeResult[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alive = workers.filter((w) => w.status !== 'exited');
  const exited = exitedWorkers(workerHistory, now, 7);
  const paused = cluster?.status.paused === true;
  const started = cluster?.started === true;

  const probe = async () => {
    setProbing(true);
    setError(null);
    try {
      setProbes(await probeClusterTemplates());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  };

  const togglePause = async () => {
    await (paused ? resumeCluster() : pauseCluster()).catch(() => {});
    await refresh();
  };

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface p-5 md:p-8">
      <div className="max-w-4xl">
        <h1 className="mb-6 text-18 font-medium">工作器</h1>
        <Section
          title={`${alive.length} 个 worker 活着`}
          aside={
            <Button disabled={!started} onClick={togglePause}>
              {paused ? '恢复调度' : '暂停调度'}
            </Button>
          }
        >
          {!loaded ? (
            <SkeletonRows rows={3} />
          ) : alive.length === 0 ? (
            <EmptyState title="现在没有活着的 worker。" hint="有运行开始时，worker 会出现在这里。" />
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {alive.map((worker) => (
                <WorkerCard
                  key={worker.workerId}
                  worker={worker}
                  run={runs.find((r) => r.task.workerId === worker.workerId)}
                  now={now}
                  lockCount={locks.filter((l) => l.workerId === worker.workerId).length}
                />
              ))}
            </div>
          )}
        </Section>
        <Section title={`最近 7 天退出 · ${exited.length}`}>
          {!loaded ? (
            <SkeletonRows rows={2} />
          ) : exited.length === 0 ? (
            <EmptyState title="最近 7 天没有退出的 worker。" />
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {exited.map((entry) => (
                <WorkerCard
                  key={entry.workerId}
                  worker={entry}
                  run={workerRunFacts(entry, runs).run}
                  now={now}
                  lockCount={0}
                  exited
                />
              ))}
            </div>
          )}
        </Section>
        <Section
          title="模板"
          aside={
            <Button disabled={probing || !started} onClick={probe}>
              {probing ? '正在探测…' : '探测凭据'}
            </Button>
          }
        >
          {error && <p className="mb-2 text-14 text-failed">探测没有完成：{error}。确认 daemon 在线后再试一次。</p>}
          {!templates ? (
            <SkeletonRows rows={3} />
          ) : templates.templates.length === 0 ? (
            <EmptyState title="还没有配置模板。" hint="在 daemon 的配置里添加 worker 模板后，这里会列出来。" />
          ) : (
            <ul className="flex flex-col gap-2">
              {templates.templates.map((template) => {
                const result = probes?.find((p) => p.templateName === template.name);
                return (
                  <li key={template.name} className="min-w-0 rounded-ui border border-line bg-surface-2 px-3 py-2">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-15">{template.name}</span>
                      <ModelName id={result?.model ?? template.model} className="text-13 text-ink-muted" />
                      <span className="text-13 text-ink-muted">
                        {busyWorkers(workers, template.name)} / {template.maxConcurrent} 在用
                      </span>
                      {result && (
                        <span className={`ml-auto text-13 ${result.ok ? 'text-done' : 'text-failed'}`}>
                          {result.ok ? `凭据可用 · ${result.durationMs} ms` : '凭据坏了'}
                        </span>
                      )}
                    </div>
                    {result && !result.ok && (
                      <p className="mt-1 text-14 break-words text-failed">
                        {result.reason ? `${result.reason}。` : ''}检查这个模板对应后端的凭据后，再探测一次。
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
