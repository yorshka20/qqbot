import { useSyncExternalStore } from 'react';

export const TABS = ['overview', 'source', 'trigger', 'eval', 'execution', 'settings'] as const;
export type Tab = (typeof TABS)[number];

export const EXECUTION_VIEWS = ['jobs', 'workers', 'tickets'] as const;
export type ExecutionView = (typeof EXECUTION_VIEWS)[number];

export type Route =
  | { tab: Exclude<Tab, 'execution'> }
  | { tab: 'execution'; view: ExecutionView; ticketId: string | null };

export function parseRoute(hash: string): Route {
  const [tab, view, ticketId] = hash.replace(/^#\/?/, '').split('/');
  if (tab === 'execution') {
    const known = EXECUTION_VIEWS.find((v) => v === view) ?? 'jobs';
    return { tab, view: known, ticketId: known === 'tickets' && ticketId ? decodeURIComponent(ticketId) : null };
  }
  const known = TABS.find((t) => t === tab);
  return known && known !== 'execution' ? { tab: known } : { tab: 'overview' };
}

export function routeHref(route: Route): string {
  if (route.tab !== 'execution') {
    return `#/${route.tab}`;
  }
  const ticket = route.ticketId ? `/${encodeURIComponent(route.ticketId)}` : '';
  return `#/execution/${route.view}${ticket}`;
}

export function executionHref(view: ExecutionView, ticketId: string | null = null): string {
  return routeHref({ tab: 'execution', view, ticketId });
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}
