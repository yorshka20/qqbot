import { useCluster } from '../app/ClusterData';
import { DaemonControls } from '../app/DaemonControls';
import { StatusDot } from '../components/StatusDot';
import { daemonSummary } from '../lib/daemon';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

const NOT_PROVIDED = <span className="text-muted-foreground">daemon 未提供</span>;

export function DaemonGroup() {
  const { cluster, unreachable, loaded, health } = useCluster();
  const summary = daemonSummary(cluster, unreachable, loaded);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
        <Row label="状态">
          <span className="inline-flex items-center gap-2">
            <StatusDot tone={summary.tone} />
            {summary.label}
          </span>
        </Row>
        <Row label="连接">{!loaded ? '正在连接' : unreachable ? '没有响应' : '已连接'}</Row>
        <Row label="启动时间">{health ? new Date(health.startedAt).toLocaleString('zh-CN') : NOT_PROVIDED}</Row>
        <Row label="在跑 / 并发">
          {summary.running} / {summary.capacity}
        </Row>
        <Row label="状态目录">{NOT_PROVIDED}</Row>
        <Row label="版本">{NOT_PROVIDED}</Row>
      </div>
      <DaemonControls />
    </div>
  );
}
