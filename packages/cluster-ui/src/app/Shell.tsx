import { ArrowLeft, Inbox, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '../components/ui/sidebar';
import { TooltipProvider } from '../components/ui/tooltip';
import { Composer } from '../composer/Composer';
import { TicketSheet } from '../composer/TicketSheet';
import { InboxPage } from '../inbox/InboxPage';
import { buildInbox } from '../lib/inbox';
import { readSidebarOpen, readTaskTab, rememberTaskTab } from '../lib/memory';
import { homePath, inboxPath, parentPath, parseAppLocation, settingsPath, withOverlay } from '../lib/routes';
import { SettingsLayout } from '../settings/SettingsLayout';
import { TaskPage } from '../task/TaskPage';
import { AppSidebar } from './AppSidebar';
import { Banner } from './Banner';
import { useCluster } from './ClusterData';
import { HomePage } from './HomePage';
import { overlayIsOpen, useKey } from './keys';

function focusWhenRendered(selector: string): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
}

function GlobalKeys() {
  const location = useLocation();
  const navigate = useNavigate();
  const { isMobile, state, setOpen, setOpenMobile } = useSidebar();

  const lastPath = useRef(location.pathname);
  useEffect(() => {
    if (lastPath.current !== location.pathname) {
      lastPath.current = location.pathname;
      setOpenMobile(false);
    }
  }, [location.pathname, setOpenMobile]);

  useKey('n', (event) => {
    event.preventDefault();
    navigate({ pathname: location.pathname, search: withOverlay(location.search, { new: true }) });
  });
  useKey('/', (event) => {
    event.preventDefault();
    if (isMobile) {
      setOpenMobile(true);
    } else if (state === 'collapsed') {
      setOpen(true);
    }
    focusWhenRendered('[data-search]');
  });
  useKey('a', (event) => {
    const box = () => document.querySelector<HTMLElement>('[data-answer-box]');
    if (box()) {
      event.preventDefault();
      box()?.focus();
      return;
    }
    const current = parseAppLocation(location.pathname, location.search);
    if (current.page === 'task' && (current.tab ?? readTaskTab()) !== 'chat') {
      event.preventDefault();
      rememberTaskTab('chat');
      const params = new URLSearchParams(location.search);
      params.set('tab', 'chat');
      navigate({ pathname: location.pathname, search: `?${params.toString()}` });
      focusWhenRendered('[data-answer-box]');
    }
  });
  useKey('Escape', () => {
    if (overlayIsOpen()) {
      return;
    }
    const target = parentPath(parseAppLocation(location.pathname, location.search));
    if (target !== `${location.pathname}${location.search}`) {
      navigate(target);
    }
  });
  return null;
}

function MobileBar() {
  const { runs, help } = useCluster();
  const location = useLocation();
  const navigate = useNavigate();
  const pending = useMemo(() => buildInbox(runs, help, null).length, [runs, help]);
  const current = parseAppLocation(location.pathname, location.search);

  return (
    <>
      {current.page !== 'home' && (
        <Button variant="ghost" size="icon" aria-label="返回" asChild className="md:hidden">
          <Link to={parentPath(current)}>
            <ArrowLeft />
          </Link>
        </Button>
      )}
      <div className="ml-auto flex items-center gap-1 md:hidden">
        <Button variant="ghost" size="sm" aria-label="收件箱" asChild>
          <Link to={inboxPath()}>
            <Inbox />
            {pending > 0 && <Badge variant="secondary">{pending}</Badge>}
          </Link>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="新任务"
          onClick={() => navigate({ pathname: location.pathname, search: withOverlay(location.search, { new: true }) })}
        >
          <Plus />
        </Button>
      </div>
    </>
  );
}

export function Shell() {
  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={readSidebarOpen()} className="h-dvh min-h-0">
        <GlobalKeys />
        <AppSidebar />
        <SidebarInset className="min-h-0 overflow-hidden">
          <header className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
            <SidebarTrigger />
            <MobileBar />
          </header>
          <Banner />
          <main className="min-h-0 flex-1 overflow-y-auto">
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="/t/:taskId" element={<TaskPage />} />
              <Route path="/t/:taskId/w/:workerId" element={<TaskPage />} />
              <Route path="/settings" element={<Navigate to={settingsPath()} replace />} />
              <Route path="/settings/:group" element={<SettingsLayout />} />
              <Route path="*" element={<Navigate to={homePath()} replace />} />
            </Routes>
          </main>
        </SidebarInset>
        <Composer />
        <TicketSheet />
      </SidebarProvider>
    </TooltipProvider>
  );
}
