import { Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useCluster } from '../app/ClusterData';
import { useListCursor } from '../app/keys';
import { type Route, routeHref, withRoute } from '../app/route';
import { groupRunSections, RUN_SECTION_LABEL } from '../lib/runs';
import { STAGE_LABEL } from '../lib/stage';
import { useNow } from '../lib/useNow';
import type { RunWindow } from '../lib/window';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { INPUT_CLASS } from '../ui/Field';
import { SkeletonRows } from '../ui/Skeleton';
import { Composer } from './Composer';
import { RunRow } from './RunRow';

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <h2 className="border-b border-line/60 px-5 pt-3 pb-1.5 text-14 font-medium text-ink-muted">
      {label} · {count}
    </h2>
  );
}

function FilterChip({ label, clearHref }: { label: string; clearHref: string }) {
  return (
    <a href={clearHref} className="inline-flex items-center gap-1 rounded-ui bg-surface-2 px-2 py-0.5 text-13">
      {label}
      <X className="size-3.5 text-ink-muted" />
    </a>
  );
}

const NEXT_WINDOW: Record<RunWindow, RunWindow> = { '24h': '7d', '7d': 'all', all: 'all' };

export function RunList({ route }: { route: Route }) {
  const { runs, loaded, hasMoreHistory, loadMoreHistory, workerExits } = useCluster();
  const [search, setSearch] = useState('');
  const [chosenWindow, setChosenWindow] = useState<RunWindow>('24h');
  const runWindow: RunWindow = route.stage ? 'all' : chosenWindow;
  const now = useNow();

  const sections = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return groupRunSections(
      runs.filter(
        (run) =>
          (!route.project || run.task.project === route.project) &&
          (!route.stage || run.stage === route.stage) &&
          (!needle || run.task.description.toLowerCase().includes(needle)),
      ),
      { now, window: runWindow },
    );
  }, [runs, route.project, route.stage, search, now, runWindow]);
  const visible = useMemo(() => sections.flatMap((section) => section.rows), [sections]);

  const hrefOf = (id: string) => withRoute(route, { runId: id, composing: false });
  const hrefs = visible.map(({ run }) => hrefOf(run.task.id));
  const { cursor } = useListCursor(hrefs);
  const indexOf = useMemo(() => new Map(visible.map(({ run }, index) => [run.task.id, index])), [visible]);

  const loadEarlier = () => {
    setChosenWindow(NEXT_WINDOW[runWindow]);
    if (hasMoreHistory) {
      loadMoreHistory();
    }
  };

  return (
    <>
      <header className="flex items-center gap-2 px-4 pt-4 pb-3">
        <h1 className="text-18 font-medium">运行</h1>
        <input
          data-search
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索（/）"
          aria-label="搜索运行"
          className={`${INPUT_CLASS} ml-auto max-w-40 py-1 text-13`}
        />
        <a
          href={withRoute(route, { composing: true, runId: null })}
          aria-label="新运行"
          className="rounded-ui p-1 text-ink-muted hover:bg-surface-2 md:hidden"
        >
          <Plus className="size-5" strokeWidth={1.75} />
        </a>
      </header>
      {(route.project || route.stage) && (
        <div className="flex gap-1.5 px-4 pb-2">
          {route.project && <FilterChip label={route.project} clearHref={withRoute(route, { project: null })} />}
          {route.stage && <FilterChip label={STAGE_LABEL[route.stage]} clearHref={withRoute(route, { stage: null })} />}
        </div>
      )}
      {route.composing && <Composer closeHref={withRoute(route, { composing: false })} />}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loaded && <SkeletonRows rows={5} />}
        {loaded && visible.length === 0 && runs.length === 0 && (
          <EmptyState
            title="还没有运行。"
            hint="说一句要做什么，agent 会接手。"
            action={
              <a
                href={routeHref({ section: 'runs', composing: true })}
                className="inline-flex items-center gap-1.5 rounded-ui bg-ink px-3 py-1.5 text-14 font-medium text-bg hover:opacity-90"
              >
                派一件事
              </a>
            }
          />
        )}
        {loaded && visible.length === 0 && runs.length > 0 && (
          <EmptyState title="没有符合条件的运行。" hint="清掉筛选再看看。" />
        )}
        {loaded && runs.length > 0 && (
          <>
            {sections.map((section) => (
              <section key={section.key}>
                <SectionHeading label={RUN_SECTION_LABEL[section.key]} count={section.rows.length} />
                {section.rows.map(({ run, depth, lastChild, childRuns }) => {
                  const index = indexOf.get(run.task.id) ?? 0;
                  return (
                    <RunRow
                      key={run.task.id}
                      run={run}
                      depth={depth}
                      lastChild={lastChild}
                      childRuns={childRuns}
                      href={hrefs[index]}
                      index={index}
                      now={now}
                      exitedAt={run.task.workerId ? workerExits.get(run.task.workerId) : undefined}
                      selected={run.task.id === route.runId}
                      cursor={index === cursor}
                    />
                  );
                })}
              </section>
            ))}
            {!sections.some((section) => section.key === 'ended') && (
              <SectionHeading label={RUN_SECTION_LABEL.ended} count={0} />
            )}
            {(runWindow !== 'all' || hasMoreHistory) && (
              <div className="px-2 py-2">
                <Button onClick={loadEarlier}>加载更早的运行</Button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
