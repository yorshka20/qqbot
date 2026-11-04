import { useCluster } from '../app/ClusterData';
import { busyWorkers, runningWorkers, spareSlots } from '../lib/slots';

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
    </div>
  );
}
