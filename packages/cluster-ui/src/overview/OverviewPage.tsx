import { useMemo } from 'react';
import { useCluster } from '../app/ClusterData';
import { routeHref } from '../app/route';
import type { Stage } from '../lib/stage';
import { buildBranches, layoutTopology } from '../lib/topology';
import { useNow } from '../lib/useNow';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonRows } from '../ui/Skeleton';
import { spareSlots } from '../workers/slots';
import { BranchList } from './BranchList';
import { TopologyMap } from './TopologyMap';

function Count({ label, value, href, tone }: { label: string; value: number; href: string; tone?: string }) {
  return (
    <a href={href} className="whitespace-nowrap hover:underline">
      {label}{' '}
      <span className={`text-18 font-medium ${value > 0 ? (tone ?? 'text-ink') : 'text-ink-muted'}`}>{value}</span>
    </a>
  );
}

export function OverviewPage() {
  const { runs, workers, locks, templates, loaded } = useCluster();
  const now = useNow();

  const branches = useMemo(
    () => buildBranches(runs, workers, { window: '24h', liveOnly: false, now }),
    [runs, workers, now],
  );
  const topology = useMemo(() => layoutTopology(branches, locks), [branches, locks]);

  const count = (stage: Stage) => runs.filter((r) => r.stage === stage).length;
  const stageHref = (stage: Stage) => routeHref({ section: 'runs', stage });

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-surface p-5 md:p-8">
      <h1 className="mb-4 text-18 font-medium">总览</h1>
      {!loaded ? (
        <SkeletonRows rows={4} />
      ) : branches.length === 0 ? (
        <EmptyState
          title="现在没有 worker 在工作。"
          hint="派一件事，这里会出现它的拓扑。"
          action={
            <a
              href={routeHref({ section: 'runs', composing: true })}
              className="rounded-ui px-3 py-1.5 text-14 font-medium text-ink hover:bg-surface-2"
            >
              新运行
            </a>
          }
        />
      ) : (
        <>
          <p className="mb-6 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-15 text-ink-muted">
            <Count label="在跑" value={count('running')} href={stageHref('running')} tone="text-working" />
            <Count label="等你" value={count('asking')} href={stageHref('asking')} tone="text-attention" />
            <Count label="排队" value={count('queued')} href={stageHref('queued')} />
            <Count label="空闲槽" value={spareSlots(templates, workers)} href={routeHref({ section: 'workers' })} />
          </p>
          <div className="hidden overflow-x-auto md:block">
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
