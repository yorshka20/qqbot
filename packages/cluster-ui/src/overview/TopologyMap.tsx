import { routeHref } from '../app/route';
import { STAGE_LABEL, STAGE_TONE, TONE_TEXT, type Tone } from '../lib/stage';
import { formatSpan, toMs } from '../lib/time';
import { type Topology, type TopologyNode, WORKER_STATE_LABEL, WORKER_STATE_TONE } from '../lib/topology';
import { runSpanLabel } from '../runs/RunRow';
import { StatusDot } from '../ui/StatusDot';

const EDGE_STROKE: Record<Tone, string> = {
  attention: 'stroke-attention',
  working: 'stroke-working',
  done: 'stroke-done',
  failed: 'stroke-failed',
  muted: 'stroke-line',
};

type NodeOf<K extends TopologyNode['kind']> = Extract<TopologyNode, { kind: K }>;

export function WorkerFacts({ node, now }: { node: NodeOf<'worker'>; now: number }) {
  const { worker, run, state } = node;
  const started = toMs(run?.task.workerStartedAt) ?? worker.spawnedAt ?? worker.stats.registeredAt;
  const ended = toMs(run?.task.completedAt);
  const tone = WORKER_STATE_TONE[state];
  return (
    <>
      <div className="flex items-center gap-1.5 text-13">
        <StatusDot tone={tone} breathing={state === 'working'} />
        <span className="truncate font-medium">{worker.templateName}</span>
        {run?.task.workerPid !== undefined && <span className="font-mono text-ink-muted">{run.task.workerPid}</span>}
        <span className="ml-auto flex shrink-0 gap-1.5 text-ink-muted">
          {node.lockedFiles > 0 && <span>锁 {node.lockedFiles}</span>}
          <span className={TONE_TEXT[tone]}>{WORKER_STATE_LABEL[state]}</span>
          <span>{formatSpan((ended ?? now) - started)}</span>
        </span>
      </div>
      <p className="line-clamp-2 text-13 text-ink-muted">{worker.lastReportSummary ?? '还没有报告。'}</p>
    </>
  );
}

function NodeCard({ node, now }: { node: TopologyNode; now: number }) {
  const box = { left: node.x, top: node.y, width: node.w, height: node.h };
  const className =
    'absolute block overflow-hidden rounded-ui bg-surface-2 px-2.5 py-1.5 hover:outline hover:outline-line';

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
      return (
        <a href={routeHref({ section: 'runs', runId: run.task.id })} style={box} className={className}>
          <div className={`text-13 font-medium ${TONE_TEXT[STAGE_TONE[run.stage]]}`}>
            {STAGE_LABEL[run.stage]} · {runSpanLabel(run, now)}
          </div>
          <div className="truncate text-15">{run.title}</div>
        </a>
      );
    }
    case 'worker':
      return (
        <a
          href={node.run ? routeHref({ section: 'runs', runId: node.run.task.id }) : routeHref({ section: 'workers' })}
          style={box}
          className={className}
        >
          <WorkerFacts node={node} now={now} />
        </a>
      );
  }
}

/** Nodes are positioned HTML so text truncates and links focus; only the edges need SVG. */
export function TopologyMap({ topology, now }: { topology: Topology; now: number }) {
  return (
    <div className="relative" style={{ width: topology.width, height: topology.height }}>
      <svg className="absolute inset-0 fill-none" width={topology.width} height={topology.height} aria-hidden>
        {topology.edges.map((edge) => (
          <path key={edge.id} d={edge.path} className={EDGE_STROKE[edge.tone]} strokeWidth={1} />
        ))}
      </svg>
      {topology.nodes.map((node) => (
        <NodeCard key={node.id} node={node} now={now} />
      ))}
    </div>
  );
}
