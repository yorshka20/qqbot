import { Inbox, Plus, Settings } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { StatusDot } from '../components/StatusDot';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '../components/ui/sidebar';
import { buildInbox } from '../lib/inbox';
import { inboxPath, parseAppLocation, settingsPath, withOverlay } from '../lib/routes';
import type { Tone } from '../lib/stage';
import { useCluster } from './ClusterData';
import { TaskListPanel } from './TaskListPanel';

function daemonState(data: ReturnType<typeof useCluster>): { tone: Tone; label: string } {
  if (!data.loaded) {
    return { tone: 'muted', label: '正在连接 daemon…' };
  }
  if (data.unreachable) {
    return { tone: 'failed', label: 'daemon 没有响应' };
  }
  if (data.cluster && !data.cluster.started) {
    return { tone: 'attention', label: '调度已停止' };
  }
  if (data.cluster?.status.paused) {
    return { tone: 'attention', label: '调度已暂停' };
  }
  return { tone: 'done', label: '调度运行中' };
}

export function AppSidebar() {
  const data = useCluster();
  const location = useLocation();
  const navigate = useNavigate();
  const current = parseAppLocation(location.pathname, location.search);
  const pending = useMemo(() => buildInbox(data.runs, data.help, null).length, [data.runs, data.help]);
  const daemon = daemonState(data);

  return (
    <Sidebar>
      <SidebarHeader className="gap-2">
        <div className="flex items-center justify-between px-1">
          <span className="font-medium">Agent Cluster</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={daemon.label}>
                <StatusDot tone={daemon.tone} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{daemon.label}</DropdownMenuLabel>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Button
          onClick={() => navigate({ pathname: location.pathname, search: withOverlay(location.search, { new: true }) })}
        >
          <Plus />
          新任务
        </Button>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={current.page === 'inbox'}>
              <Link to={inboxPath()}>
                <Inbox />
                <span>收件箱</span>
                {pending > 0 && (
                  <Badge variant="secondary" className="ml-auto">
                    {pending}
                  </Badge>
                )}
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <TaskListPanel />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={current.page === 'settings'}>
              <Link to={settingsPath()}>
                <Settings />
                <span>设置</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
