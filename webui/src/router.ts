/**
 * Hash-based router for the webui.
 *
 * Routes:
 * - #/           → files (Output 资源)
 * - #/reports    → reports list (微信报告)
 * - #/report/:id → report detail
 */

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type Route =
  | { page: 'files' }
  | { page: 'reports' }
  | { page: 'report'; id: string }
  | { page: 'insights' }
  | { page: 'zhihu' }
  | { page: 'moments' }
  | { page: 'qdrant' }
  | { page: 'stats' }
  | { page: 'memory' }
  | { page: 'cluster' }
  | { page: 'lan' }
  | { page: 'tickets' }
  | { page: 'logs' };

export type PageName = Route['page'];

// ────────────────────────────────────────────────────────────────────────────
// Parsing & Navigation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse current location hash into a Route object.
 */
export function parseHash(): Route {
  const hash = window.location.hash.slice(1); // Remove leading #

  if (!hash || hash === '/') {
    return { page: 'files' };
  }

  if (hash === '/reports') {
    return { page: 'reports' };
  }

  if (hash === '/insights') {
    return { page: 'insights' };
  }

  if (hash === '/zhihu') {
    return { page: 'zhihu' };
  }

  if (hash === '/moments') {
    return { page: 'moments' };
  }

  if (hash === '/qdrant') {
    return { page: 'qdrant' };
  }

  if (hash === '/stats') {
    return { page: 'stats' };
  }

  if (hash === '/memory') {
    return { page: 'memory' };
  }

  if (hash === '/cluster') {
    return { page: 'cluster' };
  }

  if (hash === '/lan') {
    return { page: 'lan' };
  }

  if (hash === '/tickets') {
    return { page: 'tickets' };
  }

  if (hash === '/logs') {
    return { page: 'logs' };
  }

  const reportMatch = hash.match(/^\/report\/(.+)$/);
  if (reportMatch?.[1]) {
    return { page: 'report', id: reportMatch[1] };
  }

  return { page: 'files' };
}

/**
 * Update location hash based on Route.
 */
export function setHash(route: Route): void {
  switch (route.page) {
    case 'files':
      window.location.hash = '/';
      break;
    case 'reports':
      window.location.hash = '/reports';
      break;
    case 'report':
      window.location.hash = `/report/${route.id}`;
      break;
    case 'insights':
      window.location.hash = '/insights';
      break;
    case 'zhihu':
      window.location.hash = '/zhihu';
      break;
    case 'moments':
      window.location.hash = '/moments';
      break;
    case 'qdrant':
      window.location.hash = '/qdrant';
      break;
    case 'stats':
      window.location.hash = '/stats';
      break;
    case 'memory':
      window.location.hash = '/memory';
      break;
    case 'cluster':
      window.location.hash = '/cluster';
      break;
    case 'lan':
      window.location.hash = '/lan';
      break;
    case 'tickets':
      window.location.hash = '/tickets';
      break;
    case 'logs':
      window.location.hash = '/logs';
      break;
  }
}

/**
 * Navigate to a new route (updates both state and hash).
 */
export function navigateTo(route: Route, setRoute: (r: Route) => void): void {
  setRoute(route);
  setHash(route);
}

// ────────────────────────────────────────────────────────────────────────────
// Route helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Check if the current route matches a page (useful for nav highlighting).
 */
export function isActivePage(route: Route, page: PageName): boolean {
  if (page === 'reports') {
    return route.page === 'reports' || route.page === 'report';
  }
  return route.page === page;
}
