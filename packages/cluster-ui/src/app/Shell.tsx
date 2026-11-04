import { useEffect, useRef } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '../components/ui/sidebar';
import { TooltipProvider } from '../components/ui/tooltip';
import { InboxPage } from '../inbox/InboxPage';
import { readSidebarOpen } from '../lib/memory';
import { homePath, parentPath, parseAppLocation, settingsPath, withOverlay } from '../lib/routes';
import { TaskPage } from '../task/TaskPage';
import { AppSidebar } from './AppSidebar';
import { Banner } from './Banner';
import { HomePage } from './HomePage';
import { overlayIsOpen, useKey } from './keys';
import { Placeholder } from './Placeholder';

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

export function Shell() {
  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={readSidebarOpen()} className="h-dvh min-h-0">
        <GlobalKeys />
        <AppSidebar />
        <SidebarInset className="min-h-0 overflow-hidden">
          <header className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
            <SidebarTrigger />
          </header>
          <Banner />
          <main className="min-h-0 flex-1 overflow-y-auto">
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="/t/:taskId" element={<TaskPage />} />
              <Route path="/t/:taskId/w/:workerId" element={<TaskPage />} />
              <Route path="/settings" element={<Navigate to={settingsPath()} replace />} />
              <Route path="/settings/:group" element={<Placeholder />} />
              <Route path="*" element={<Navigate to={homePath()} replace />} />
            </Routes>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
