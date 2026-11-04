import type { ClusterStatusResponse } from '@qqbot/api-types';
import { useCluster } from '../app/ClusterData';
import { busyWorkers, runningWorkers, spareSlots } from '../lib/slots';

function WorktreePools({ cluster }: { cluster: ClusterStatusResponse | null }) {
  const pools = cluster?.status.worktrees ?? [];
  if (pools.length === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">worktree 池</h3>
      <ul className="flex flex-col gap-2">
        {pools.map((pool) => {
          const inUse = (kind: string) => pool.leased.filter((lease) => lease.kind === kind).length;
          return (
            <li key={pool.project} className="flex flex-col gap-1 rounded-lg border bg-card p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">{pool.project}</span>
                <span className="font-mono text-sm">
                  executor {inUse('executor')} / {pool.size} · planner {inUse('planner')} / {pool.plannerSize}
                </span>
              </div>
              {pool.leased.map((lease) => (
                <p key={lease.slot} className="font-mono text-xs break-all text-muted-foreground">
                  {lease.path}
                </p>
              ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ConcurrencyGroup() {
  const { templates, cluster } = useCluster();
  if (!templates) {
    return <p className="text-sm text-muted-foreground">正在读取模板…</p>;
  }
  if (templates.templates.length === 0) {
    return <p className="text-sm text-muted-foreground">还没有配置模板，没有并发可看。</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-baseline justify-between gap-3 rounded-lg border bg-card p-3">
        <span className="text-sm font-medium">全局</span>
        <span className="font-mono text-sm">
          {runningWorkers(cluster)} / {cluster?.status.maxConcurrentWorkers ?? 0}
        </span>
      </p>
      <ul className="flex flex-col gap-2">
        {templates.templates.map((template) => (
          <li key={template.name} className="flex items-baseline justify-between gap-3 rounded-lg border bg-card p-3">
            <span className="text-sm font-medium">{template.name}</span>
            <span className="font-mono text-sm">
              {busyWorkers(cluster, template.name)} / {template.maxConcurrent}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-sm">
        空闲槽 <span className="font-mono">{spareSlots(cluster, templates)}</span>
      </p>
      <p className="text-xs text-muted-foreground">只数正在运行的进程；失败、结束的 worker 不占并发。</p>
      <WorktreePools cluster={cluster} />
    </div>
  );
}
