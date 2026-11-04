import { Inbox, LogOut, Plus, Settings } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { signOut } from '../auth/session';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
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
import { useCluster } from './ClusterData';
import { DaemonPopover } from './DaemonPopover';
import { TaskListPanel } from './TaskListPanel';
import { setTheme, type ThemeChoice, useThemeChoice } from './theme';

export function AppSidebar() {
  const data = useCluster();
  const location = useLocation();
  const navigate = useNavigate();
  const current = parseAppLocation(location.pathname, location.search);
  const pending = useMemo(() => buildInbox(data.runs, data.help, null).length, [data.runs, data.help]);
  const theme = useThemeChoice();

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
        <TaskListPanel keys={current.page !== 'inbox'} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton isActive={current.page === 'settings'}>
                  <Settings />
                  <span>设置</span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="min-w-48">
                <DropdownMenuItem onClick={() => navigate(settingsPath())}>
                  <Settings />
                  打开设置
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>主题</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as ThemeChoice)}>
                  <DropdownMenuRadioItem value="dark">深色</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="light">浅色</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">跟随系统</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => signOut()}>
                  <LogOut />
                  退出控制台
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
