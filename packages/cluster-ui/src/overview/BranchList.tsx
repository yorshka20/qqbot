import type { ClusterLock, ClusterWorkerRegistration } from '@qqbot/api-types';
import { useCluster } from '../app/ClusterData';
import { routeHref } from '../app/route';
import type { Run } from '../lib/runs';
import { STAGE_LABEL, STAGE_TONE } from '../lib/stage';
import { type ProjectBranch, type RunBranch, type TopologyNode, workerState } from '../lib/topology';
import { runSpanLabel } from '../runs/RunRow';
import { STAGE_ICON, StatePill } from '../ui/StatePill';
import { StatusBar } from '../ui/StatusBar';
import { WorkerFacts, workerCardClass } from './TopologyMap';

type WorkerNode = Extract<TopologyNode, { kind: 'worker' }>;

function workerNode(worker: ClusterWorkerRegistration, run: Run | undefined, locks: ClusterLock[]): WorkerNode {
  return {
    kind: 'worker',
    id: worker.workerId,
    worker,
    run,
    state: workerState(run),
    lockedFiles: locks.filter((l) => l.workerId === worker.workerId).length,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  };
}

function RunItem({ branch, now, depth, last }: { branch: RunBranch; now: number; depth: number; last: boolean }) {
  const { locks } = useCluster();
  const { run } = branch;
  const tone = STAGE_TONE[run.stage];
  const worker = run.worker ? workerNode(run.worker, run, locks) : null;
  return (
    <li className={depth > 0 ? 'relative pl-6' : ''}>
      {depth > 0 && (
        <>
          <span className={`absolute top-0 left-2 w-px bg-line ${last ? 'h-[1.15rem]' : 'bottom-0'}`} />
          <span className="absolute top-[1.15rem] left-2 h-px w-3.5 bg-line" />
        </>
      )}
      <a
        href={routeHref({ section: 'runs', runId: run.task.id })}
        className="relative my-1 block overflow-hidden rounded-ui border border-line bg-surface-2 p-3 pl-4"
      >
        <StatusBar tone={tone} active={run.stage === 'running' || run.stage === 'asking'} />
        <div className="flex flex-wrap items-center gap-1.5">
          {depth > 0 && <span className="text-12 text-ink-muted">子运行</span>}
          <StatePill
            tone={tone}
            label={STAGE_LABEL[run.stage]}
            icon={STAGE_ICON[run.stage]}
            breathing={run.stage === 'running'}
          />
          {branch.children.length > 0 && (
            <span className="rounded-ui bg-line/60 px-1.5 py-0.5 text-12 text-ink-muted">
              规划器 · 派生 {branch.children.length}
            </span>
          )}
        </div>
        <div className="truncate text-16">{run.title}</div>
        <div className="flex items-center gap-2 text-13 text-ink-muted">
          <span className="shrink-0">{runSpanLabel(run, now)}</span>
          {run.task.model && <span className="ml-auto min-w-0 truncate font-mono text-12">{run.task.model}</span>}
        </div>
        {worker && (
          <div className={`mt-2 ${workerCardClass(worker.state)}`}>
            <WorkerFacts node={worker} now={now} />
          </div>
        )}
      </a>
      {branch.children.length > 0 && (
        <ul>
          {branch.children.map((child, i) => (
            <RunItem
              key={child.run.task.id}
              branch={child}
              now={now}
              depth={depth + 1}
              last={i === branch.children.length - 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The map's content on a phone: a tree does not fit 375px, a list on a tree rail does. */
export function BranchList({ branches, now }: { branches: ProjectBranch[]; now: number }) {
  const { locks } = useCluster();
  return (
    <div className="flex flex-col gap-6">
      {branches.map((project) => (
        <section key={project.alias}>
          <a
            href={routeHref({ section: 'runs', project: project.alias })}
            className="mb-1 block rounded-ui bg-surface-2/40 px-3 py-1.5 text-14 font-medium"
          >
            {project.alias}
          </a>
          <ul>
            {project.roots.map((root) => (
              <RunItem key={root.run.task.id} branch={root} now={now} depth={0} last />
            ))}
          </ul>
          {project.idleWorkers.map((worker) => {
            const node = workerNode(worker, undefined, locks);
            return (
              <a
                key={worker.workerId}
                href={routeHref({ section: 'workers' })}
                className={`my-1 block ${workerCardClass(node.state)}`}
              >
                <WorkerFacts node={node} now={now} />
              </a>
            );
          })}
        </section>
      ))}
    </div>
  );
}
