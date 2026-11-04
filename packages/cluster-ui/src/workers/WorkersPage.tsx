import type { EnrichedWorkerRegistration } from '@qqbot/api-types';
import { useState } from 'react';
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
import { formatSpan } from '../lib/time';
import { WORKER_STATE_LABEL, WORKER_STATE_TONE, workerState } from '../lib/topology';
import { useNow } from '../lib/useNow';
import { Button, ConfirmButton } from '../ui/Button';
import { Section } from '../ui/Section';
import { StatusDot } from '../ui/StatusDot';
import { busyWorkers } from './slots';

function WorkerCard({ worker, run, now }: { worker: EnrichedWorkerRegistration; run?: Run; now: number }) {
  const { refresh } = useCluster();
  const state = workerState(run);
  const kill = async () => {
    await killClusterWorker(worker.workerId).catch(() => {});
    await refresh();
  };
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-ui bg-surface-2 p-3">
      <div className="flex items-center gap-1.5 text-13">
        <StatusDot tone={WORKER_STATE_TONE[state]} breathing={state === 'working'} />
        <span className="font-medium">{worker.templateName}</span>
        <span className="text-ink-muted">{worker.project}</span>
        <span className="ml-auto text-ink-muted">
          {WORKER_STATE_LABEL[state]} · {formatSpan(now - worker.spawnedAt)}
        </span>
      </div>
      {run ? (
        <a href={routeHref({ section: 'runs', runId: run.task.id })} className="truncate text-15 hover:underline">
          {run.title}
        </a>
      ) : (
        <p className="text-15 text-ink-muted">没有运行。</p>
      )}
      <p className="line-clamp-2 text-13 text-ink-muted">{worker.lastReportSummary ?? '还没有报告。'}</p>
      <div className="flex items-center justify-between gap-2 text-13 text-ink-muted">
        <span className="min-w-0 truncate font-mono">
          {run?.task.workerPid ? `pid ${run.task.workerPid}` : worker.workerId}
        </span>
        <ConfirmButton label="终止 worker" confirmLabel="确认终止" onConfirm={kill} />
      </div>
    </div>
  );
}

export function WorkersPage() {
  const { workers, runs, templates, cluster, refresh } = useCluster();
  const now = useNow();
  const [probes, setProbes] = useState<TemplateProbeResult[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alive = workers.filter((w) => w.status !== 'exited');
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
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface p-4 md:p-6">
      <div className="max-w-4xl">
        <h1 className="mb-4 text-17 font-medium">工作器</h1>
        <Section
          title={`${alive.length} 个 worker 活着`}
          aside={
            <Button disabled={!started} onClick={togglePause}>
              {paused ? '恢复调度' : '暂停调度'}
            </Button>
          }
        >
          {alive.length === 0 ? (
            <p className="text-15 text-ink-muted">现在没有 worker。</p>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {alive.map((worker) => (
                <WorkerCard
                  key={worker.workerId}
                  worker={worker}
                  run={runs.find((r) => r.task.workerId === worker.workerId)}
                  now={now}
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
          {error && <p className="mb-1 text-13 text-failed">{error}</p>}
          <ul className="flex flex-col gap-2">
            {templates?.templates.map((template) => {
              const result = probes?.find((p) => p.templateName === template.name);
              return (
                <li key={template.name} className="min-w-0">
                  <div className="flex items-baseline gap-2 text-15">
                    <span>{template.name}</span>
                    <span className="text-13 text-ink-muted">
                      {busyWorkers(workers, template.name)} / {template.maxConcurrent} 在用
                    </span>
                    {result && (
                      <span className={`ml-auto text-13 ${result.ok ? 'text-done' : 'text-failed'}`}>
                        {result.ok ? `凭据可用 · ${result.durationMs} ms` : '凭据坏了'}
                      </span>
                    )}
                  </div>
                  {result && !result.ok && result.reason && (
                    <p className="text-13 break-words text-ink-muted">{result.reason}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      </div>
    </div>
  );
}
