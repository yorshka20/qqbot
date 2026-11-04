import type { ClusterStatusResponse, ClusterTemplatesResponse, ClusterWorkerRegistration } from '@qqbot/api-types';
import type { Tone } from './stage';

export interface DaemonSummary {
  tone: Tone;
  label: string;
  running: number;
  capacity: number;
}

export function daemonSummary(
  cluster: ClusterStatusResponse | null,
  unreachable: boolean,
  loaded: boolean,
  workers: ClusterWorkerRegistration[],
  templates: ClusterTemplatesResponse | null,
): DaemonSummary {
  const running = workers.filter((w) => w.status !== 'exited').length;
  const capacity = (templates?.templates ?? []).reduce((sum, t) => sum + t.maxConcurrent, 0);
  const base = { running, capacity };
  if (!loaded) {
    return { ...base, tone: 'muted', label: '正在连接 daemon…' };
  }
  if (unreachable) {
    return { ...base, tone: 'failed', label: 'daemon 没有响应' };
  }
  if (cluster && !cluster.started) {
    return { ...base, tone: 'attention', label: '调度已停止' };
  }
  if (cluster?.status.paused) {
    return { ...base, tone: 'attention', label: '调度已暂停' };
  }
  return { ...base, tone: 'done', label: '调度运行中' };
}
