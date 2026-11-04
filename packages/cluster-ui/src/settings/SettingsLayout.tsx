import { ArrowLeft } from 'lucide-react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import { Button } from '../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { homePath, parseAppLocation, SETTINGS_GROUPS, type SettingsGroup, settingsPath } from '../lib/routes';
import { ConcurrencyGroup } from './ConcurrencyGroup';
import { ConsoleGroup } from './ConsoleGroup';
import { DaemonGroup } from './DaemonGroup';
import { ProjectsGroup } from './ProjectsGroup';
import { TemplatesGroup } from './TemplatesGroup';
import { WorkersGroup } from './WorkersGroup';

const GROUP_LABEL: Record<SettingsGroup, string> = {
  workers: '工作器',
  templates: '模板',
  projects: '项目',
  concurrency: '并发',
  daemon: 'daemon',
  console: '控制台',
};

const GROUP_VIEW: Record<SettingsGroup, () => React.ReactNode> = {
  workers: () => <WorkersGroup />,
  templates: () => <TemplatesGroup />,
  projects: () => <ProjectsGroup />,
  concurrency: () => <ConcurrencyGroup />,
  daemon: () => <DaemonGroup />,
  console: () => <ConsoleGroup />,
};

export function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const parsed = parseAppLocation(location.pathname, location.search);
  const group = parsed.page === 'settings' ? parsed.group : SETTINGS_GROUPS[0];

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <aside className="shrink-0 border-b p-3 md:w-52 md:border-r md:border-b-0">
        <Button variant="ghost" size="sm" asChild className="mb-2">
          <Link to={homePath()}>
            <ArrowLeft />
            返回首页
          </Link>
        </Button>
        <h1 className="mb-2 hidden px-2 text-lg font-semibold md:block">设置</h1>
        <div className="md:hidden">
          <Select value={group} onValueChange={(next) => navigate(settingsPath(next as SettingsGroup))}>
            <SelectTrigger className="w-full" aria-label="设置分组">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SETTINGS_GROUPS.map((value) => (
                <SelectItem key={value} value={value}>
                  {GROUP_LABEL[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <nav className="hidden flex-col gap-0.5 md:flex" aria-label="设置分组">
          {SETTINGS_GROUPS.map((value) => (
            <NavLink
              key={value}
              to={settingsPath(value)}
              className={({ isActive }) =>
                `rounded-md px-2 py-1.5 text-sm ${isActive ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'}`
              }
            >
              {GROUP_LABEL[value]}
            </NavLink>
          ))}
        </nav>
      </aside>
      <section className="min-w-0 flex-1 p-4 md:p-6">
        <h2 className="mb-4 text-lg font-semibold">{GROUP_LABEL[group]}</h2>
        {GROUP_VIEW[group]()}
      </section>
    </div>
  );
}
