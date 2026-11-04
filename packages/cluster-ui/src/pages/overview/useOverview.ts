import type {
  ClusterDaemonHealthResponse,
  ClusterHelpRequest,
  ClusterStatusResponse,
  ClusterTask,
} from '@qqbot/api-types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getClusterJob, getClusterStatus, getDaemonHealth, listClusterHelpRequests, listClusterJobs } from '../../api';
import { useRefreshOnClusterEvents } from '../../stream/useClusterStream';
import { classifyTasks, isRecentJob, isTerminalJob, type JobTask, type TaskAttention } from './attention';

const POLL_INTERVAL_MS = 5000;
const JOB_SCAN_LIMIT = 100;
const REFRESH_EVENTS = ['init', 'worker_status', 'help_request', 'task_spawned'] as const;

export interface Overview {
  health: ClusterDaemonHealthResponse | null;
  cluster: ClusterStatusResponse | null;
  help: ClusterHelpRequest[];
  attention: TaskAttention;
  error: string | null;
  refresh: () => Promise<void>;
}

const NO_ATTENTION: TaskAttention = { stuck: [], finished: [] };

/**
 * `GET /api/cluster/tasks` holds active tasks only, a finished one has already left it, so
 * failed and completed tasks are read job by job. Each job detail carries up to 16KB of output
 * per task and a finished job no longer changes, so those are fetched once.
 */
export function useOverview(): Overview {
  const [health, setHealth] = useState<ClusterDaemonHealthResponse | null>(null);
  const [cluster, setCluster] = useState<ClusterStatusResponse | null>(null);
  const [help, setHelp] = useState<ClusterHelpRequest[]>([]);
  const [attention, setAttention] = useState<TaskAttention>(NO_ATTENTION);
  const [error, setError] = useState<string | null>(null);

  const finishedJobTasks = useRef(new Map<string, ClusterTask[]>());
  const refreshing = useRef(false);

  const loadJobTasks = useCallback(async (): Promise<JobTask[]> => {
    const now = Date.now();
    const jobs = (await listClusterJobs({ limit: JOB_SCAN_LIMIT })).filter((job) => isRecentJob(job, now));
    const perJob = await Promise.all(
      jobs.map(async (job) => {
        const known = finishedJobTasks.current.get(job.id);
        if (known) {
          return { job, tasks: known };
        }
        const { tasks } = await getClusterJob(job.id);
        return { job, tasks };
      }),
    );
    finishedJobTasks.current = new Map(perJob.filter(({ job }) => isTerminalJob(job)).map((j) => [j.job.id, j.tasks]));
    return perJob.flatMap(({ job, tasks }) => tasks.map((task) => ({ job, task })));
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshing.current) {
      return;
    }
    refreshing.current = true;
    try {
      const [daemon, snapshot] = await Promise.all([getDaemonHealth(), getClusterStatus()]);
      setHealth(daemon);
      setCluster(snapshot);
      if (!snapshot.started) {
        setHelp([]);
        setAttention(NO_ATTENTION);
      } else {
        const [requests, tasks] = await Promise.all([listClusterHelpRequests(), loadJobTasks()]);
        setHelp(requests);
        setAttention(classifyTasks(tasks));
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      refreshing.current = false;
    }
  }, [loadJobTasks]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useRefreshOnClusterEvents(REFRESH_EVENTS, refresh, cluster?.started === true);

  return { health, cluster, help, attention, error, refresh };
}
