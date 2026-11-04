import type { ClusterLock } from '@qqbot/api-types';
import { useCluster } from '../app/ClusterData';
import { routeHref } from '../app/route';
import { STAGE_LABEL, STAGE_TONE, TONE_TEXT } from '../lib/stage';
import { type ProjectBranch, type RunBranch, workerState } from '../lib/topology';
import { runSpanLabel } from '../runs/RunRow';
import { WorkerFacts } from './TopologyMap';

function lockCount(locks: ClusterLock[], workerId: string): number {
  return locks.filter((l) => l.workerId === workerId).length;
}

function RunItem({ branch, now, depth }: { branch: RunBranch; now: number; depth: number }) {
  const { locks } = useCluster();
  const { run } = branch;
  return (
    <li style={{ paddingLeft: depth * 12 }}>
      <a href={routeHref({ section: 'runs', runId: run.task.id })} className="block py-1.5">
        <div className={`text-13 font-medium ${TONE_TEXT[STAGE_TONE[run.stage]]}`}>
          {STAGE_LABEL[run.stage]} · {runSpanLabel(run, now)}
        </div>
        <div className="truncate text-15">{run.title}</div>
        {run.worker && (
          <div className="mt-1 ml-3">
            <WorkerFacts
              node={{
                kind: 'worker',
                id: run.worker.workerId,
                worker: run.worker,
                run,
                state: workerState(run),
                lockedFiles: lockCount(locks, run.worker.workerId),
                x: 0,
                y: 0,
                w: 0,
                h: 0,
              }}
              now={now}
            />
          </div>
        )}
      </a>
      {branch.children.length > 0 && (
        <ul>
          {branch.children.map((child) => (
            <RunItem key={child.run.task.id} branch={child} now={now} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The map's content on a phone: a tree does not fit 375px, a two-level list does. */
export function BranchList({ branches, now }: { branches: ProjectBranch[]; now: number }) {
  return (
    <div className="flex flex-col gap-5">
      {branches.map((project) => (
        <section key={project.alias}>
          <a
            href={routeHref({ section: 'runs', project: project.alias })}
            className="text-13 font-medium text-ink-muted"
          >
            {project.alias}
          </a>
          <ul>
            {project.roots.map((root) => (
              <RunItem key={root.run.task.id} branch={root} now={now} depth={0} />
            ))}
          </ul>
          {project.idleWorkers.map((worker) => (
            <p key={worker.workerId} className="py-1 text-13 text-ink-muted">
              {worker.templateName} 空闲
            </p>
          ))}
        </section>
      ))}
    </div>
  );
}
