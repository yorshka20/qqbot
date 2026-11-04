import { Plus } from 'lucide-react';
import { useCluster } from '../app/ClusterData';
import { useListCursor } from '../app/keys';
import { type Route, routeHref } from '../app/route';
import type { InboxItem } from '../lib/inbox';
import { useNow } from '../lib/useNow';
import { InboxRow } from './InboxRow';
import { useInbox } from './useInbox';

function itemHref(item: InboxItem): string {
  const runId = item.kind === 'ask' ? (item.run?.task.id ?? null) : item.run.task.id;
  return routeHref({ section: 'inbox', runId });
}

export function InboxList({ route }: { route: Route }) {
  const { loaded } = useCluster();
  const items = useInbox(route);
  const now = useNow();
  const hrefs = items.map(itemHref);
  const { cursor } = useListCursor(hrefs);

  return (
    <>
      <header className="flex items-center justify-between px-4 pt-3 pb-2">
        <h1 className="text-18 font-medium">{items.length > 0 && `${items.length} 件需要你`}</h1>
        <a
          href={routeHref({ section: 'runs', composing: true })}
          aria-label="新运行"
          className="rounded-ui p-1 text-ink-muted hover:bg-surface-2 md:hidden"
        >
          <Plus className="size-5" strokeWidth={1.75} />
        </a>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loaded && items.length === 0 && <p className="px-4 py-2 text-15 text-ink-muted">没有需要你的事。</p>}
        {items.map((item, index) => (
          <InboxRow
            key={item.key}
            item={item}
            index={index}
            href={hrefs[index]}
            now={now}
            selected={item.kind === 'ask' ? item.run?.task.id === route.runId : item.run.task.id === route.runId}
            cursor={index === cursor}
          />
        ))}
      </div>
    </>
  );
}
