import type { ClusterStatusResponse } from '@qqbot/api-types';
import { runningWorkers } from './slots';
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
): DaemonSummary {
  const base = { running: runningWorkers(cluster), capacity: cluster?.status.maxConcurrentWorkers ?? 0 };
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
