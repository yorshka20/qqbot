import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

/**
 * A built single-page app in `dir`, answered from the request path: the file when there is one,
 * and `index.html` for a navigation (a GET that accepts `text/html`) to a path without a file,
 * which is how client-side routes deep-link. Null for everything else, so an API client asking
 * for JSON at an unknown path still gets its 404. The directory is looked up per request, so a
 * build swapped in while the server runs is served from the next request on.
 */
export function serveSpaFile(dir: string, pathname: string, req: Request): Response | null {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return null;
  }
  const root = resolve(dir);
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
  return file ? new Response(Bun.file(file)) : null;
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
