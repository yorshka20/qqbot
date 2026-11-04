import { useEffect, useMemo, useState } from 'react';
import { useCluster } from '../app/ClusterData';
import { routeHref } from '../app/route';
import { type OverviewChoice, readOverviewChoice, rememberOverviewChoice } from '../lib/memory';
import { spareSlots } from '../lib/slots';
import type { Stage } from '../lib/stage';
import { buildBranches, layoutTopology } from '../lib/topology';
import { useNow } from '../lib/useNow';
import { needsOlderHistory, RUN_WINDOW_LABEL, type RunWindow } from '../lib/window';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonRows } from '../ui/Skeleton';
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

const WINDOWS: RunWindow[] = ['24h', '7d', 'all'];

function Controls({ choice, onChange }: { choice: OverviewChoice; onChange: (choice: OverviewChoice) => void }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-14">
      <fieldset className="flex gap-1" aria-label="时间窗口">
        {WINDOWS.map((window) => (
          <button
            key={window}
            type="button"
            aria-pressed={choice.window === window}
            onClick={() => onChange({ ...choice, window })}
            className={`rounded-ui px-2.5 py-1 ${
              choice.window === window ? 'bg-surface-2 font-medium text-ink' : 'text-ink-muted hover:bg-surface-2'
            }`}
          >
            {RUN_WINDOW_LABEL[window]}
          </button>
        ))}
      </fieldset>
      <label className="flex items-center gap-1.5 text-ink-muted">
        <input
          type="checkbox"
          checked={choice.liveOnly}
          onChange={(e) => onChange({ ...choice, liveOnly: e.target.checked })}
        />
        仅在跑
      </label>
    </div>
  );
}

export function OverviewPage() {
  const { runs, workers, locks, templates, loaded, oldestLoadedAt, hasMoreHistory, loadMoreHistory } = useCluster();
  const now = useNow();
  const [choice, setChoice] = useState(readOverviewChoice);

  const update = (next: OverviewChoice) => {
    setChoice(next);
    rememberOverviewChoice(next);
  };

  const wantsOlder = !choice.liveOnly && needsOlderHistory(oldestLoadedAt, choice.window, now, hasMoreHistory);
  useEffect(() => {
    if (wantsOlder) {
      loadMoreHistory();
    }
  }, [wantsOlder, loadMoreHistory]);

  const branches = useMemo(
    () => buildBranches(runs, workers, { window: choice.window, liveOnly: choice.liveOnly, now }),
    [runs, workers, choice, now],
  );
  const topology = useMemo(() => layoutTopology(branches, locks), [branches, locks]);

  const count = (stage: Stage) => runs.filter((r) => r.stage === stage).length;
  const stageHref = (stage: Stage) => routeHref({ section: 'runs', stage });

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-surface p-5 md:p-8">
      <h1 className="mb-4 text-18 font-medium">总览</h1>
      {!loaded ? (
        <SkeletonRows rows={4} />
      ) : (
        <>
          <p className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-15 text-ink-muted">
            <Count label="在跑" value={count('running')} href={stageHref('running')} tone="text-working" />
            <Count label="等你" value={count('asking')} href={stageHref('asking')} tone="text-attention" />
            <Count label="排队" value={count('queued')} href={stageHref('queued')} />
            <Count label="空闲槽" value={spareSlots(templates, workers)} href={routeHref({ section: 'workers' })} />
          </p>
          <Controls choice={choice} onChange={update} />
          {branches.length === 0 ? (
            <EmptyState
              title={choice.liveOnly ? '现在没有 worker 在工作。' : '这段时间里没有运行。'}
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
              <div className="hidden overflow-x-auto md:block">
                <TopologyMap topology={topology} now={now} />
              </div>
              <div className="md:hidden">
                <BranchList branches={branches} now={now} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
