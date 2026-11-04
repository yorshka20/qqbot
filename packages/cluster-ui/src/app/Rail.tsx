import { Cpu, FolderGit2, Inbox, type LucideIcon, Network, Play, Plus, Settings } from 'lucide-react';
import { useInbox } from '../inbox/useInbox';
import type { Tone } from '../lib/stage';
import { StatusDot } from '../ui/StatusDot';
import { useCluster } from './ClusterData';
import { type Route, routeHref, type Section } from './route';

interface Item {
  section: Section;
  label: string;
  icon: LucideIcon;
}

const ITEMS: Item[] = [
  { section: 'inbox', label: '收件箱', icon: Inbox },
  { section: 'overview', label: '总览', icon: Network },
  { section: 'runs', label: '运行', icon: Play },
  { section: 'projects', label: '项目', icon: FolderGit2 },
  { section: 'workers', label: '工作器', icon: Cpu },
  { section: 'settings', label: '设置', icon: Settings },
];

/** Five tabs fit a phone; 项目 is reached from 设置 there. */
const TABS = ITEMS.filter((item) => item.section !== 'projects');

const BADGE = 'rounded-ui bg-attention/15 px-1.5 text-12 font-medium text-attention';

function clusterStatus(data: ReturnType<typeof useCluster>): { tone: Tone; label: string; breathing: boolean } {
  const { unreachable, cluster, runs } = data;
  if (unreachable) {
    return { tone: 'failed', label: 'daemon 掉线', breathing: false };
  }
  if (cluster?.status.paused) {
    return { tone: 'attention', label: '已暂停', breathing: false };
  }
  if (cluster && !cluster.started) {
    return { tone: 'attention', label: '调度已停', breathing: false };
  }
  const running = runs.filter((r) => r.stage === 'running').length;
  return running > 0
    ? { tone: 'working', label: `在跑 ${running}`, breathing: true }
    : { tone: 'working', label: '空闲', breathing: false };
}

function RailHeader() {
  const { tone, label, breathing } = clusterStatus(useCluster());
  return (
    <div className="mb-3 flex flex-col gap-1 px-2 pt-1 text-13 lg:mb-4">
      <span className="hidden text-16 font-medium lg:block">Cluster</span>
      <span className="flex items-center justify-center gap-2 text-ink-muted lg:justify-start" title={label}>
        <StatusDot tone={tone} breathing={breathing} />
        <span className="hidden lg:inline">{label}</span>
      </span>
    </div>
  );
}

export function Rail({ route }: { route: Route }) {
  const count = useInbox(route).length;
  return (
    <nav className="hidden w-14 shrink-0 flex-col gap-0.5 p-2 md:flex lg:w-44">
      <RailHeader />
      <a
        href={routeHref({ section: 'runs', composing: true })}
        title="新运行（n）"
        className="mb-2 flex items-center gap-2.5 rounded-ui px-2 py-1.5 text-15 font-medium text-ink hover:bg-surface-2"
      >
        <Plus className="size-5 shrink-0" strokeWidth={1.75} />
        <span className="hidden lg:inline">新运行</span>
      </a>
      {ITEMS.map(({ section, label, icon: Icon }) => {
        const active = route.section === section;
        return (
          <a
            key={section}
            href={routeHref({ section })}
            title={label}
            aria-current={active ? 'page' : undefined}
            className={`relative flex items-center gap-2.5 rounded-ui px-2 py-2 text-15 hover:bg-surface-2 ${active ? 'bg-surface-2 font-medium text-ink' : 'text-ink-muted'}`}
          >
            <Icon className="size-5 shrink-0" strokeWidth={1.75} />
            <span className="hidden lg:inline">{label}</span>
            {section === 'inbox' && count > 0 && (
              <span className={`absolute top-0 right-0 ${BADGE} lg:static lg:ml-auto`}>{count}</span>
            )}
          </a>
        );
      })}
    </nav>
  );
}

export function TabBar({ route }: { route: Route }) {
  const count = useInbox(route).length;
  return (
    <nav className="flex shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
      {TABS.map(({ section, label, icon: Icon }) => {
        const active = route.section === section;
        return (
          <a
            key={section}
            href={routeHref({ section })}
            aria-current={active ? 'page' : undefined}
            className={`relative flex flex-1 flex-col items-center gap-0.5 py-1.5 text-12 ${active ? 'text-ink' : 'text-ink-muted'}`}
          >
            <Icon className="size-5" strokeWidth={1.75} />
            {label}
            {section === 'inbox' && count > 0 && (
              <span className={`absolute top-0.5 left-1/2 ml-2 ${BADGE}`}>{count}</span>
            )}
          </a>
        );
      })}
    </nav>
  );
}
