import type { ClusterJob, ClusterTask } from '../../../types';
import { JobRow } from './JobRow';

export function JobsPanel({
  jobs,
  onTaskClick,
  onKillJob,
  onKillTask,
}: {
  jobs: ClusterJob[] | null;
  onTaskClick: (task: ClusterTask) => void;
  onKillJob: (jobId: string) => void;
  onKillTask: (taskId: string) => void;
}) {
  if (!jobs) {
    return <div className="text-sm text-zinc-500 dark:text-zinc-400">-</div>;
  }
  if (jobs.length === 0) {
    return (
      <div className="text-sm text-zinc-500 dark:text-zinc-400">No jobs yet — submit one from the Control panel</div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {jobs.map((j) => (
        <JobRow key={j.id} job={j} onTaskClick={onTaskClick} onKillJob={onKillJob} onKillTask={onKillTask} />
      ))}
    </div>
  );
}
