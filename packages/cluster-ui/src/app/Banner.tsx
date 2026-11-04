import { PauseCircle, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { resumeCluster, startCluster } from '../api';
import { Button } from '../ui/Button';
import { useCluster } from './ClusterData';

/** The console's only standing notice. A healthy cluster shows nothing here. */
export function Banner() {
  const { unreachable, cluster, refresh } = useCluster();
  const [busy, setBusy] = useState(false);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await action().catch(() => {});
    await refresh();
    setBusy(false);
  };

  if (unreachable) {
    return (
      <p className="flex items-center gap-2 border-l-[3px] border-failed bg-failed/10 px-4 py-2 text-14 text-failed">
        <WifiOff className="size-4 shrink-0" strokeWidth={2} />
        daemon 没有响应（{window.location.host}），5 秒后重试。
      </p>
    );
  }
  if (cluster && !cluster.started) {
    return (
      <div className="flex items-center gap-3 border-l-[3px] border-attention bg-attention/10 px-4 py-2 text-14 text-attention">
        <PauseCircle className="size-4 shrink-0" strokeWidth={2} />
        <span>调度已停止，运行信息可能是旧的。</span>
        <Button disabled={busy} onClick={() => act(startCluster)}>
          启动调度
        </Button>
      </div>
    );
  }
  if (cluster?.status.paused) {
    return (
      <div className="flex items-center gap-3 border-l-[3px] border-attention bg-attention/10 px-4 py-2 text-14 text-attention">
        <PauseCircle className="size-4 shrink-0" strokeWidth={2} />
        <span>调度已暂停，排队的运行不会开始。</span>
        <Button disabled={busy} onClick={() => act(resumeCluster)}>
          恢复调度
        </Button>
      </div>
    );
  }
  return null;
}
