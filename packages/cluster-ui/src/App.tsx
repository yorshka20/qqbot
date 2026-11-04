import { GitBranch, Moon, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSession } from './auth/session';
import { TokenGate } from './auth/TokenGate';
import { ExecutionPage } from './pages/execution';
import { OverviewPage } from './pages/overview';
import { SettingsPage } from './pages/settings';
import { type ExecutionView, parseRoute, routeHref, TABS, type Tab, useHash } from './router';

const DARK_MODE_KEY = 'darkMode';

const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview',
  source: 'Source',
  trigger: 'Trigger',
  eval: 'Eval',
  execution: 'Execution',
  settings: 'Settings',
};

const WAITING_ON_ENGINE: Partial<Record<Tab, string>> = {
  source: '等 Phase 2：Source 由 Engine 提供，目前没有数据源。',
  trigger: '等 Phase 2：Trigger 由 Engine 提供，目前没有数据源。',
  eval: '等 Phase 2：Eval 由 Engine 提供，目前没有数据源。',
};

function useDarkMode(): [boolean, (dark: boolean) => void] {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem(DARK_MODE_KEY);
    return stored === null ? window.matchMedia('(prefers-color-scheme: dark)').matches : stored === 'true';
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  return [
    dark,
    (next) => {
      localStorage.setItem(DARK_MODE_KEY, String(next));
      setDark(next);
    },
  ];
}

function Console({ dark, onDarkChange }: { dark: boolean; onDarkChange: (dark: boolean) => void }) {
  const route = parseRoute(useHash());

  // Execution stays mounted behind the other tabs: a half-written task or ticket must survive a look at Overview.
  const execution = useRef<{ view: ExecutionView; ticketId: string | null }>({ view: 'jobs', ticketId: null });
  if (route.tab === 'execution') {
    execution.current = { view: route.view, ticketId: route.ticketId };
  }
  const waiting = WAITING_ON_ENGINE[route.tab];

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-zinc-100 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100">
      <header className="shrink-0 border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-4 py-2 flex items-center gap-1 overflow-x-auto">
        <GitBranch className="w-4 h-4 mr-2 shrink-0 text-zinc-600 dark:text-zinc-300" />
        <nav className="flex items-center gap-1">
          {TABS.map((tab) => (
            <a
              key={tab}
              href={tab === 'execution' ? `#/execution/${execution.current.view}` : routeHref({ tab })}
              aria-current={route.tab === tab ? 'page' : undefined}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                route.tab === tab
                  ? 'bg-zinc-100 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
              }`}
            >
              {TAB_LABEL[tab]}
            </a>
          ))}
        </nav>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => onDarkChange(!dark)}
          aria-label={dark ? '切换到浅色' : '切换到深色'}
          className="p-1.5 rounded-lg text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
        >
          {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </header>

      <div className="flex-1 min-h-0">
        {route.tab === 'overview' && <OverviewPage />}
        {route.tab === 'settings' && <SettingsPage />}
        {waiting && <div className="p-8 text-center text-sm text-zinc-500 dark:text-zinc-400">{waiting}</div>}
        <div className={route.tab === 'execution' ? 'h-full' : 'hidden'}>
          <ExecutionPage
            active={route.tab === 'execution'}
            view={execution.current.view}
            ticketId={execution.current.ticketId}
          />
        </div>
      </div>
    </div>
  );
}

export function App() {
  const session = useSession();
  const [dark, setDark] = useDarkMode();

  if (!session.token) {
    return <TokenGate rejected={session.rejected} />;
  }
  return <Console dark={dark} onDarkChange={setDark} />;
}
