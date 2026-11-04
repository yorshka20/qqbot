import { useCluster } from '../app/ClusterData';
import { busyWorkers, spareSlots } from '../lib/slots';

export function ConcurrencyGroup() {
  const { templates, workers } = useCluster();
  if (!templates) {
    return <p className="text-sm text-muted-foreground">正在读取模板…</p>;
  }
  if (templates.templates.length === 0) {
    return <p className="text-sm text-muted-foreground">还没有配置模板，没有并发可看。</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {templates.templates.map((template) => (
          <li key={template.name} className="flex items-baseline justify-between gap-3 rounded-lg border bg-card p-3">
            <span className="text-sm font-medium">{template.name}</span>
            <span className="font-mono text-sm">
              {busyWorkers(workers, template.name)} / {template.maxConcurrent}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-sm">
        空闲槽 <span className="font-mono">{spareSlots(templates, workers)}</span>
      </p>
      <p className="text-xs text-muted-foreground">
        这是各模板余量之和，是上限：调度器没有提供全局并发上限，实际可同时跑的数量可能更少。
      </p>
    </div>
  );
}
