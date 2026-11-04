import { Pause, Play, Power, Square } from 'lucide-react';
import { useState } from 'react';
import { pauseCluster, resumeCluster, startCluster, stopCluster } from '../api';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { useCluster } from './ClusterData';

export function DaemonControls() {
  const { cluster, refresh } = useCluster();
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const started = cluster?.started === true;
  const paused = cluster?.status.paused === true;

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      setConfirmStop(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {started ? (
          <>
            {paused ? (
              <Button variant="outline" disabled={busy} onClick={() => act(resumeCluster)}>
                <Play />
                恢复调度
              </Button>
            ) : (
              <Button variant="outline" disabled={busy} onClick={() => act(pauseCluster)}>
                <Pause />
                暂停调度
              </Button>
            )}
            <Button variant="destructive" disabled={busy} onClick={() => setConfirmStop(true)}>
              <Square />
              停止调度
            </Button>
          </>
        ) : (
          <Button disabled={busy || cluster === null} onClick={() => act(startCluster)}>
            <Power />
            启动调度
          </Button>
        )}
      </div>
      {error && <p className="text-xs break-words text-failed">操作没有成功：{error}。确认 daemon 在线后再试一次。</p>}
      <Dialog open={confirmStop} onOpenChange={setConfirmStop}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>停止调度？</DialogTitle>
            <DialogDescription>在跑的 worker 会被终止，排队的运行不会再被派发。</DialogDescription>
          </DialogHeader>
          {error && <p className="text-xs break-words text-failed">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmStop(false)}>
              取消
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => act(stopCluster)}>
              <Square />
              确认停止
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
