import type { ClusterWorkerRegistration } from '@qqbot/api-types';
import { Skull } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { killClusterWorker } from '../api';
import { useCluster } from '../app/ClusterData';
import { StatusDot } from '../components/StatusDot';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { modelDisplayName } from '../lib/model';
import type { Run } from '../lib/runs';
import { TONE_TEXT } from '../lib/stage';
import { pathOfRun } from '../lib/taskList';
import { formatClock, formatSpan } from '../lib/time';
import { usageFacts } from '../lib/usage';
import { useNow } from '../lib/useNow';
import { exitedWorkers, workerResult, workerRunFacts } from '../lib/workers';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-muted-foreground">{label} </span>
      {children}
    </span>
  );
}

function KillDialog({ worker }: { worker: ClusterWorkerRegistration }) {
  const { refresh } = useCluster();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kill = async () => {
    setBusy(true);
    setError(null);
    try {
      await killClusterWorker(worker.workerId);
      await refresh();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <Skull />
        终止 worker
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>终止这个 worker？</DialogTitle>
            <DialogDescription>{worker.templateName} 正在做的运行会中断。</DialogDescription>
          </DialogHeader>
          {error && <p className="text-xs break-words text-failed">终止没有成功：{error}。</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" disabled={busy} onClick={kill}>
              <Skull />
              确认终止
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function WorkerCard({
  worker,
  run,
  runs,
  now,
  lockCount,
  exited,
}: {
  worker: ClusterWorkerRegistration;
  run: Run | undefined;
  runs: Run[];
  now: number;
  lockCount: number;
  exited: boolean;
}) {
  const { templates, workerExits } = useCluster();
  const result = workerResult(worker);
  const model = run?.task.model ?? templates?.templates.find((t) => t.name === worker.templateName)?.model;
  const startedAt = worker.spawnedAt ?? worker.stats.registeredAt;
  const endedAt = worker.exitedAt ?? workerExits.get(worker.workerId);
  const usage = usageFacts(run?.task.usage);
  const pid = run?.task.workerPid;

  return (
    <div className={`flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 ${exited ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusDot tone={exited ? result.tone : 'working'} breathing={!exited} />
        <span className="text-sm font-medium">{worker.templateName}</span>
        {model && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm text-muted-foreground">{modelDisplayName(model)}</span>
            </TooltipTrigger>
            <TooltipContent className="font-mono">{model}</TooltipContent>
          </Tooltip>
        )}
        <span className="text-sm text-muted-foreground">{worker.project}</span>
        {exited && <span className={`ml-auto text-xs ${TONE_TEXT[result.tone]}`}>{result.label}</span>}
      </div>
      {run ? (
        <Link to={pathOfRun(run, runs)} className="truncate text-sm hover:underline">
          {run.title}
        </Link>
      ) : (
        <p className="text-sm text-muted-foreground">{exited ? '这条运行不在已加载的范围内。' : '没有运行。'}</p>
      )}
      {worker.lastReportSummary && (
        <p className="line-clamp-2 text-sm break-words text-muted-foreground">{worker.lastReportSummary}</p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <Fact label="开始">{formatClock(startedAt, now)}</Fact>
        <Fact label={endedAt === undefined ? '已跑' : '用时'}>{formatSpan((endedAt ?? now) - startedAt)}</Fact>
        {endedAt !== undefined && <Fact label="结束">{formatClock(endedAt, now)}</Fact>}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
        <Fact label="pid">{pid ?? '未知'}</Fact>
        <Fact label="context">{usage.context}</Fact>
        <Fact label="输入">{usage.input}</Fact>
        <Fact label="输出">{usage.output}</Fact>
        {!exited && <Fact label="锁">{lockCount}</Fact>}
      </div>
      {!exited && (
        <div className="flex justify-end">
          <KillDialog worker={worker} />
        </div>
      )}
    </div>
  );
}

export function WorkersGroup() {
  const { workers, workerHistory, locks, runs, loaded } = useCluster();
  const now = useNow();
  const alive = workers.filter((w) => w.status !== 'exited');
  const exited = exitedWorkers(workerHistory, now, 7);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">在跑的 worker · {alive.length}</h2>
        {!loaded ? (
          <p className="text-sm text-muted-foreground">正在读取 worker…</p>
        ) : alive.length === 0 ? (
          <p className="text-sm text-muted-foreground">现在没有在跑的 worker。有运行开始时会出现在这里。</p>
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {alive.map((worker) => (
              <WorkerCard
                key={worker.workerId}
                worker={worker}
                run={runs.find((r) => r.task.workerId === worker.workerId)}
                runs={runs}
                now={now}
                lockCount={locks.filter((l) => l.workerId === worker.workerId).length}
                exited={false}
              />
            ))}
          </div>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">最近 7 天退出 · {exited.length}</h2>
        {!loaded ? (
          <p className="text-sm text-muted-foreground">正在读取 worker…</p>
        ) : exited.length === 0 ? (
          <p className="text-sm text-muted-foreground">最近 7 天没有退出的 worker。</p>
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {exited.map((entry) => (
              <WorkerCard
                key={entry.workerId}
                worker={entry}
                run={workerRunFacts(entry, runs).run}
                runs={runs}
                now={now}
                lockCount={0}
                exited
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
