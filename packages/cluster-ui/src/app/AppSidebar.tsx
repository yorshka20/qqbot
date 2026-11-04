import { Inbox, Plus, Settings } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
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
import { useCluster } from './ClusterData';
import { DaemonPopover } from './DaemonPopover';
import { TaskListPanel } from './TaskListPanel';

export function AppSidebar() {
  const data = useCluster();
  const location = useLocation();
  const navigate = useNavigate();
  const current = parseAppLocation(location.pathname, location.search);
  const pending = useMemo(() => buildInbox(data.runs, data.help, null).length, [data.runs, data.help]);

  return (
    <Sidebar>
      <SidebarHeader className="gap-2">
        <div className="flex items-center justify-between px-1">
          <span className="font-medium">Agent Cluster</span>
          <DaemonPopover />
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
