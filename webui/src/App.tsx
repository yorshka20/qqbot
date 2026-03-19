/**
 * Main App - Layout shell with route switching.
 *
 * Pages:
 * - FilesPage: Output resource management
 * - ReportsPage: WeChat report viewing
 */

import { FileText, Lightbulb, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { FilesPage, InsightsPage, ReportsPage } from './pages';
import { isActivePage, parseHash, type Route, setHash } from './router';

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);

  // Listen for hash changes (back/forward navigation)
  useEffect(() => {
    const handleHashChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const navigate = useCallback((newRoute: Route) => {
    setRoute(newRoute);
    setHash(newRoute);
  }, []);

  // Dark mode persistence
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('darkMode') === 'true');
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    localStorage.setItem('darkMode', String(darkMode));
  }, [darkMode]);

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-zinc-100 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100">
      {/* Header */}
      <header className="shrink-0 border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
        <div className="px-4 py-3 flex items-center gap-4 flex-wrap">
          {/* Navigation tabs */}
          <nav className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => navigate({ page: 'files' })}
              className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                isActivePage(route, 'files')
                  ? 'bg-zinc-100 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
              }`}
            >
              Output 资源
            </button>
            <button
              type="button"
              onClick={() => navigate({ page: 'reports' })}
              className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors flex items-center gap-1.5 ${
                isActivePage(route, 'reports')
                  ? 'bg-zinc-100 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
              }`}
            >
              <FileText className="w-4 h-4" />
              微信报告
            </button>
            <button
              type="button"
              onClick={() => navigate({ page: 'insights' })}
              className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors flex items-center gap-1.5 ${
                isActivePage(route, 'insights')
                  ? 'bg-zinc-100 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
              }`}
            >
              <Lightbulb className="w-4 h-4" />
              文章洞察
            </button>
          </nav>

          <div className="flex-1" />

          {/* Dark mode toggle */}
          <button
            type="button"
            onClick={() => setDarkMode((d) => !d)}
            className="shrink-0 p-2 rounded-lg text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
            title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Page content */}
      {route.page === 'files' && <FilesPage />}
      {(route.page === 'reports' || route.page === 'report') && (
        <ReportsPage
          reportId={route.page === 'report' ? route.id : undefined}
          onSelectReport={(id) => navigate({ page: 'report', id })}
          onBack={() => navigate({ page: 'reports' })}
        />
      )}
      {route.page === 'insights' && <InsightsPage />}
    </div>
  );
}
