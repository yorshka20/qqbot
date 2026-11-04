import { Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useCluster } from '../app/ClusterData';
import { useListCursor } from '../app/keys';
import { type Route, routeHref, withRoute } from '../app/route';
import { sortRuns } from '../lib/runs';
import { STAGE_LABEL } from '../lib/stage';
import { useNow } from '../lib/useNow';
import { Button } from '../ui/Button';
import { INPUT_CLASS } from '../ui/Field';
import { Composer } from './Composer';
import { RunRow } from './RunRow';

function FilterChip({ label, clearHref }: { label: string; clearHref: string }) {
  return (
    <a href={clearHref} className="inline-flex items-center gap-1 rounded-ui bg-surface-2 px-2 py-0.5 text-13">
      {label}
      <X className="size-3.5 text-ink-muted" />
    </a>
  );
}

export function RunList({ route }: { route: Route }) {
  const { runs, loaded, hasMoreHistory, loadMoreHistory } = useCluster();
  const [search, setSearch] = useState('');
  const now = useNow();

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return sortRuns(
      runs.filter(
        (run) =>
          (!route.project || run.task.project === route.project) &&
          (!route.stage || run.stage === route.stage) &&
          (!needle || run.task.description.toLowerCase().includes(needle)),
      ),
    );
  }, [runs, route.project, route.stage, search]);

  const hrefOf = (id: string) => withRoute(route, { runId: id, composing: false });
  const hrefs = visible.map((run) => hrefOf(run.task.id));
  const { cursor } = useListCursor(hrefs);

  return (
    <>
      <header className="flex items-center gap-2 px-4 pt-3 pb-2">
        <h1 className="text-17 font-medium">运行</h1>
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
        {loaded && visible.length === 0 && (
          <p className="px-4 py-2 text-15 text-ink-muted">
            {runs.length === 0 ? (
              <>
                还没有运行。
                <a href={routeHref({ section: 'runs', composing: true })} className="underline">
                  派一件事
                </a>
              </>
            ) : (
              '没有符合条件的运行。'
            )}
          </p>
        )}
        {visible.map((run, index) => (
          <RunRow
            key={run.task.id}
            run={run}
            href={hrefs[index]}
            index={index}
            now={now}
            selected={run.task.id === route.runId}
            cursor={index === cursor}
          />
        ))}
        {hasMoreHistory && (
          <div className="px-2 py-2">
            <Button onClick={loadMoreHistory}>加载更早的运行</Button>
          </div>
        )}
      </div>
    </>
  );
}
