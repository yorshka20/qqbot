import { InboxList } from '../inbox/InboxList';
import { OverviewPage } from '../overview/OverviewPage';
import { ProjectsPage } from '../projects/ProjectsPage';
import { RunDetail } from '../runs/RunDetail';
import { RunList } from '../runs/RunList';
import { TicketDrawer } from '../runs/TicketDrawer';
import { SettingsPage } from '../settings/SettingsPage';
import { EmptyState } from '../ui/EmptyState';
import { WorkersPage } from '../workers/WorkersPage';
import { Banner } from './Banner';
import { useCluster } from './ClusterData';
import { useKey } from './keys';
import { Rail, TabBar } from './Rail';
import { navigate, type Route, routeHref, useRoute } from './route';

function focusWhenRendered(selector: string): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
}

function useGlobalKeys(route: Route): void {
  useKey('n', (event) => {
    event.preventDefault();
    navigate(routeHref({ section: 'runs', composing: true }));
  });
  useKey('a', (event) => {
    event.preventDefault();
    focusWhenRendered('[data-answer-box]');
  });
  useKey('/', (event) => {
    event.preventDefault();
    if (route.section === 'runs') {
      focusWhenRendered('[data-search]');
      return;
    }
    // The input does not exist until the new section has rendered.
    window.addEventListener('hashchange', () => focusWhenRendered('[data-search]'), { once: true });
    navigate(routeHref({ section: 'runs' }));
  });
}

function EmptyDetail({ hint }: { hint: boolean }) {
  return (
    <div className="hidden flex-1 items-center justify-center bg-surface md:flex">
      <EmptyState title="选一条运行看详情。" hint={hint ? '用 j / k 移动，Enter 打开。' : undefined} />
    </div>
  );
}

function ListAndDetail({ route }: { route: Route }) {
  const { runs } = useCluster();
  const open = route.runId !== null;
  const list = route.section === 'inbox' ? <InboxList route={route} /> : <RunList route={route} />;
  return (
    <>
      <div
        className={`${open ? 'hidden md:flex' : 'flex'} min-h-0 w-full shrink-0 flex-col border-line bg-surface md:w-list md:border-r`}
      >
        {list}
      </div>
      {route.runId ? (
        <RunDetail key={route.runId} runId={route.runId} route={route} />
      ) : (
        <EmptyDetail hint={route.section === 'runs' && runs.length > 0} />
      )}
      {route.pin && route.pin !== route.runId && (
        <RunDetail key={`pin:${route.pin}`} runId={route.pin} route={route} pinned />
      )}
    </>
  );
}

const PAGES = {
  overview: OverviewPage,
  projects: ProjectsPage,
  workers: WorkersPage,
  settings: SettingsPage,
};

export function Shell() {
  const route = useRoute();
  useGlobalKeys(route);

  const { section } = route;
  const Page = section === 'inbox' || section === 'runs' ? null : PAGES[section];

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-bg md:flex-row">
      <Rail route={route} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Banner />
        <div className="flex min-h-0 flex-1">{Page ? <Page /> : <ListAndDetail route={route} />}</div>
      </main>
      {route.runId === null && <TabBar route={route} />}
      <TicketDrawer route={route} />
    </div>
  );
}
