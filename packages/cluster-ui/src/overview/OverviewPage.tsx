import { useMemo } from 'react';
import { useCluster } from '../app/ClusterData';
import { routeHref } from '../app/route';
import { useSeen } from '../lib/memory';
import type { Stage } from '../lib/stage';
import { buildBranches, layoutTopology } from '../lib/topology';
import { useNow } from '../lib/useNow';
import { spareSlots } from '../workers/slots';
import { BranchList } from './BranchList';
import { TopologyMap } from './TopologyMap';

function Count({ label, value, href, tone }: { label: string; value: number; href: string; tone?: string }) {
  return (
    <a href={href} className="whitespace-nowrap hover:underline">
      {label} <span className={`font-medium ${value > 0 ? (tone ?? 'text-ink') : 'text-ink-muted'}`}>{value}</span>
    </a>
  );
}

export function OverviewPage() {
  const { runs, workers, locks, templates, loaded } = useCluster();
  const seen = useSeen();
  const now = useNow();

  const branches = useMemo(() => buildBranches(runs, workers, seen), [runs, workers, seen]);
  const topology = useMemo(() => layoutTopology(branches, locks), [branches, locks]);

  const count = (stage: Stage) => runs.filter((r) => r.stage === stage).length;
  const stageHref = (stage: Stage) => routeHref({ section: 'runs', stage });

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-surface p-4 md:p-6">
      <h1 className="mb-1 text-17 font-medium">总览</h1>
      {loaded && branches.length === 0 ? (
        <p className="text-15 text-ink-muted">现在没有 worker 在工作。</p>
      ) : (
        <>
          <p className="mb-5 flex flex-wrap gap-x-4 text-13 text-ink-muted">
            <Count label="在跑" value={count('running')} href={stageHref('running')} tone="text-working" />
            <Count label="等你" value={count('asking')} href={stageHref('asking')} tone="text-attention" />
            <Count label="排队" value={count('queued')} href={stageHref('queued')} />
            <Count label="空闲槽" value={spareSlots(templates, workers)} href={routeHref({ section: 'workers' })} />
          </p>
          <div className="hidden md:block">
            <TopologyMap topology={topology} now={now} />
          </div>
          <div className="md:hidden">
            <BranchList branches={branches} now={now} />
          </div>
        </>
      )}
    </div>
  );
}
