import { useSyncExternalStore } from 'react';
import { STAGE_LABEL, type Stage } from '../lib/stage';

export const SECTIONS = ['inbox', 'overview', 'runs', 'projects', 'workers', 'settings'] as const;
export type Section = (typeof SECTIONS)[number];

export interface Route {
  section: Section;
  runId: string | null;
  /** The second run kept open beside the first. */
  pin: string | null;
  composing: boolean;
  project: string | null;
  stage: Stage | null;
  ticket: string | null;
  ticketFile: string | null;
}

export const NO_FILTERS = {
  runId: null,
  pin: null,
  composing: false,
  project: null,
  stage: null,
  ticket: null,
  ticketFile: null,
} satisfies Omit<Route, 'section'>;

function parseStage(value: string | null): Stage | null {
  return value !== null && value in STAGE_LABEL ? (value as Stage) : null;
}

export function parseRoute(hash: string): Route {
  const [path, search = ''] = hash.replace(/^#\/?/, '').split('?');
  const [section, runId] = path.split('/');
  const params = new URLSearchParams(search);
  return {
    section: SECTIONS.find((s) => s === section) ?? 'inbox',
    runId: runId ? decodeURIComponent(runId) : null,
    pin: params.get('pin'),
    composing: params.has('new'),
    project: params.get('project'),
    stage: parseStage(params.get('stage')),
    ticket: params.get('ticket'),
    ticketFile: params.get('file'),
  };
}

export function routeHref(route: Partial<Route> & Pick<Route, 'section'>): string {
  const { section, runId, pin, composing, project, stage, ticket, ticketFile } = { ...NO_FILTERS, ...route };
  const params = new URLSearchParams();
  if (pin) {
    params.set('pin', pin);
  }
  if (composing) {
    params.set('new', '1');
  }
  if (project) {
    params.set('project', project);
  }
  if (stage) {
    params.set('stage', stage);
  }
  if (ticket) {
    params.set('ticket', ticket);
  }
  if (ticketFile) {
    params.set('file', ticketFile);
  }
  const path = runId ? `${section}/${encodeURIComponent(runId)}` : section;
  return params.size > 0 ? `#/${path}?${params}` : `#/${path}`;
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

function currentHash(): string {
  return window.location.hash;
}

let cached: { hash: string; route: Route } | null = null;

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, currentHash);
  if (cached?.hash !== hash) {
    cached = { hash, route: parseRoute(hash) };
  }
  return cached.route;
}

export function navigate(href: string): void {
  window.location.hash = href;
}

/** The same screen with some of its parameters changed. */
export function withRoute(route: Route, patch: Partial<Route>): string {
  return routeHref({ ...route, ...patch });
}
