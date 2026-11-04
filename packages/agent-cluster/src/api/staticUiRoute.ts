import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { HubRoute } from '../cluster/hub/ContextHub';

/**
 * Serve a built single-page console from `dir` at `/`. The directory is looked up per
 * request so a build dropped in after the daemon started is served without a restart;
 * while it is absent every path is a 404. A navigation (a GET that accepts `text/html`) to
 * a path without a file falls back to `index.html`, which is how client-side routes
 * deep-link; an API client asking for JSON at an unknown path still gets its 404.
 */
export function staticUiRoute(dir: string): HubRoute {
  const root = resolve(dir);
  return {
    prefix: '/',
    handle(pathname, req) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return null;
      }
      if (!existsSync(root)) {
        return null;
      }
      let relative: string;
      try {
        relative = decodeURIComponent(pathname);
      } catch {
        return null;
      }
      const target = resolve(root, `.${relative}`);
      if (target !== root && !target.startsWith(root + sep)) {
        return null;
      }
      const file = resolveFile(target) ?? (isNavigation(req, target) ? resolveFile(join(root, 'index.html')) : null);
      if (!file) {
        return null;
      }
      return new Response(Bun.file(file));
    },
  };
}

function isNavigation(req: Request, target: string): boolean {
  return extname(target) === '' && (req.headers.get('accept') ?? '').includes('text/html');
}

function resolveFile(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  const stat = statSync(path);
  if (stat.isFile()) {
    return path;
  }
  if (stat.isDirectory()) {
    const index = join(path, 'index.html');
    return existsSync(index) && statSync(index).isFile() ? index : null;
  }
  return null;
}
