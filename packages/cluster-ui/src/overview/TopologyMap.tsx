import { useCluster } from '../app/ClusterData';
import { routeHref } from '../app/route';
import { STAGE_LABEL, STAGE_TONE, TONE_BG, type Tone } from '../lib/stage';
import { formatSpan, toMs } from '../lib/time';
import {
  elapsedFraction,
  type Topology,
  type TopologyNode,
  WORKER_STATE_LABEL,
  WORKER_STATE_TONE,
  type WorkerState,
} from '../lib/topology';
import { runSpanLabel } from '../runs/RunRow';
import { STAGE_ICON, StatePill } from '../ui/StatePill';
import { StatusBar } from '../ui/StatusBar';
import { StatusDot } from '../ui/StatusDot';

const EDGE_STROKE: Record<Tone, string> = {
  attention: 'stroke-attention',
  working: 'stroke-working',
  done: 'stroke-done',
  failed: 'stroke-failed',
  muted: 'stroke-line',
};

const WORKER_CARD: Record<WorkerState, string> = {
  working: 'border-working/35',
  asking: 'border-attention/40',
  failed: 'border-failed/40',
  idle: 'border-dashed border-line opacity-70',
  exited: 'border-line',
};

type NodeOf<K extends TopologyNode['kind']> = Extract<TopologyNode, { kind: K }>;

export function workerCardClass(state: WorkerState): string {
  return `rounded-ui border bg-surface-2 p-2.5 ${WORKER_CARD[state]}`;
}

export function WorkerFacts({ node, now }: { node: NodeOf<'worker'>; now: number }) {
  const { templates } = useCluster();
  const { worker, run, state } = node;
  const started = toMs(run?.task.workerStartedAt) ?? worker.spawnedAt ?? worker.stats.registeredAt;
  const ended = toMs(run?.task.completedAt);
  const elapsed = (ended ?? now) - started;
  const tone = WORKER_STATE_TONE[state];
  const model = run?.task.model ?? templates?.templates.find((t) => t.name === worker.templateName)?.model;
  const nextSteps = worker.lastReportNextSteps;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <StatusDot tone={tone} breathing={state === 'working'} />
        <span className="truncate text-14 font-medium">{worker.templateName}</span>
        {run?.task.workerPid !== undefined && (
          <span className="font-mono text-13 text-ink-muted">{run.task.workerPid}</span>
        )}
        <span className="ml-auto shrink-0">
          <StatePill tone={tone} label={WORKER_STATE_LABEL[state]} />
        </span>
      </div>
      {model && <p className="truncate font-mono text-12 text-ink-muted">{model}</p>}
      <p className={`${nextSteps ? 'line-clamp-1' : 'line-clamp-2'} text-13 text-ink-muted`}>
        {worker.lastReportSummary ?? '还没有报告。'}
      </p>
      {nextSteps && <p className="truncate text-13 text-working">→ {nextSteps}</p>}
      <div className="flex items-center gap-2 text-12 text-ink-muted">
        <span className="h-1 flex-1 rounded-ui bg-line">
          <span
            className={`block h-full rounded-ui ${TONE_BG[tone]}`}
            style={{ width: `${elapsedFraction(elapsed) * 100}%` }}
          />
        </span>
        {node.lockedFiles > 0 && <span>锁 {node.lockedFiles}</span>}
        <span className="shrink-0">{formatSpan(elapsed)}</span>
      </div>
    </div>
  );
}

function NodeCard({ node, now }: { node: TopologyNode; now: number }) {
  const box = { left: node.x, top: node.y, width: node.w, height: node.h };

  switch (node.kind) {
    case 'project':
      return (
        <a
          href={routeHref({ section: 'runs', project: node.alias })}
          style={box}
          className="absolute flex items-center truncate text-15 font-medium hover:underline"
        >
          {node.alias}
        </a>
      );
    case 'run': {
      const { run } = node;
      const tone = STAGE_TONE[run.stage];
      return (
        <a
          href={routeHref({ section: 'runs', runId: run.task.id })}
          style={box}
          className="absolute block overflow-hidden rounded-ui border border-line bg-surface-2 p-2.5 pl-3.5 hover:border-ink-muted/60"
        >
          <StatusBar tone={tone} active={run.stage === 'running' || run.stage === 'asking'} />
          <div className="flex items-center gap-1.5">
            <StatePill
              tone={tone}
              label={STAGE_LABEL[run.stage]}
              icon={STAGE_ICON[run.stage]}
              breathing={run.stage === 'running'}
            />
            {node.childRuns > 0 && (
              <span className="shrink-0 rounded-ui bg-line/60 px-1.5 py-0.5 text-12 text-ink-muted">
                规划器 · 派生 {node.childRuns}
              </span>
            )}
          </div>
          <div className="truncate text-16">{run.title}</div>
          <div className="flex items-center gap-2 text-13 text-ink-muted">
            <span className="shrink-0">{runSpanLabel(run, now)}</span>
            {run.task.model && <span className="ml-auto min-w-0 truncate font-mono text-12">{run.task.model}</span>}
          </div>
        </a>
      );
    }
    case 'worker':
      return (
        <a
          href={node.run ? routeHref({ section: 'runs', runId: node.run.task.id }) : routeHref({ section: 'workers' })}
          style={box}
          className={`absolute block overflow-hidden hover:border-ink-muted/60 ${workerCardClass(node.state)}`}
        >
          <WorkerFacts node={node} now={now} />
        </a>
      );
  }
}

/** Nodes are positioned HTML so text truncates and links focus; only the edges need SVG. */
export function TopologyMap({ topology, now }: { topology: Topology; now: number }) {
  return (
    <div className="px-2 py-2">
      <div className="relative" style={{ width: topology.width, height: topology.height }}>
        {topology.bands.map((band) => (
          <div
            key={band.alias}
            className="pointer-events-none absolute -left-2 rounded-ui bg-surface-2/40"
            style={{ top: band.y, height: band.h, width: topology.width + 16 }}
          >
            <span className="absolute top-1 left-2 text-14 font-medium text-ink-muted">{band.alias}</span>
          </div>
        ))}
        <svg className="absolute inset-0 fill-none" width={topology.width} height={topology.height} aria-hidden>
          {topology.edges.map((edge) => (
            <path
              key={edge.id}
              d={edge.path}
              className={EDGE_STROKE[edge.tone]}
              strokeWidth={edge.spawn ? 2 : 1}
              strokeLinecap="round"
            />
          ))}
        </svg>
        {topology.nodes.map((node) => (
          <NodeCard key={node.id} node={node} now={now} />
        ))}
      </div>
    </div>
  );
}
