import type { ClusterJob, ClusterTask } from '@qqbot/api-types';
import { isLive, type Tone } from './stage';

export interface Delivery {
  tone: Tone;
  label: string;
  detail?: string;
  /** The work waits on the integration branch and the owner can land it. */
  canLand: boolean;
}

/** Where the work of this run is now. Null for a run with no branch of its own. */
export function deliveryOf(job: ClusterJob | undefined, task: ClusterTask): Delivery | null {
  const integration = job?.integrationBranch;
  if (!job || !integration) {
    return null;
  }
  if (task.parentTaskId) {
    return childDelivery(task, integration);
  }
  const base = job.baseBranch;
  if (job.landedAt) {
    return { tone: 'done', label: `已合入 ${base}`, canLand: false };
  }
  if (job.landError) {
    return { tone: 'failed', label: `合入 ${base} 失败`, detail: job.landError, canLand: task.status === 'blocked' };
  }
  if (isLive(task)) {
    return { tone: 'working', label: `工作在 ${integration}，job 结束后合入 ${base}`, canLand: false };
  }
  if (task.status !== 'completed') {
    return { tone: 'muted', label: `没有合入，工作留在 ${integration}`, canLand: false };
  }
  return base
    ? { tone: 'muted', label: '没有改动要合入', canLand: false }
    : { tone: 'attention', label: `停在 ${integration}，还没有合入主分支`, canLand: true };
}

function childDelivery(task: ClusterTask, integration: string): Delivery {
  if (task.mergedAt) {
    return { tone: 'done', label: `已合入 ${integration}`, canLand: false };
  }
  if (isLive(task)) {
    return { tone: 'working', label: `工作在 ${task.branch ?? integration}`, canLand: false };
  }
  return { tone: 'muted', label: `没有合入 ${integration}`, canLand: false };
}
