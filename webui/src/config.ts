/**
 * Configurable base URL for file API and static output when webui and static file server
 * are deployed separately (e.g. webui on one machine, static server on another on the LAN).
 *
 * Set VITE_STATIC_SERVER_BASE at build time, e.g.:
 *   VITE_STATIC_SERVER_BASE=http://192.168.1.100:3456 bun run build
 * Or in .env:
 *   VITE_STATIC_SERVER_BASE=http://192.168.1.100:3456
 *
 * When unset or empty, uses relative paths (same origin). So when you open the webui at
 * http://192.168.50.209:5173, API requests go to http://192.168.50.209:5173/api/... and
 * the dev server proxy forwards them to the backend (e.g. localhost:8888 on the server).
 */

const base = (import.meta.env.VITE_STATIC_SERVER_BASE as string | undefined)?.trim() || '';

/** Base URL for the static file server (no trailing slash). Empty string means same origin (relative paths). */
export function getStaticServerBase(): string {
  return base ? base.replace(/\/$/, '') : '';
}

/** Base URL for file API requests: same-origin '/api/files' when no base set, else getStaticServerBase() + '/api/files'. */
export function getFileApiBase(): string {
  const serverBase = getStaticServerBase();
  return serverBase ? `${serverBase}/api/files` : '/api/files';
}

/** Base URL for output (static) resources: same-origin '/output' when no base set, else getStaticServerBase() + '/output'. */
export function getOutputBase(): string {
  const serverBase = getStaticServerBase();
  return serverBase ? `${serverBase}/output` : '/output';
}

/** Base URL for report API requests: same-origin '/api/reports' when no base set, else getStaticServerBase() + '/api/reports'. */
export function getReportApiBase(): string {
  const serverBase = getStaticServerBase();
  return serverBase ? `${serverBase}/api/reports` : '/api/reports';
}

/** Base URL for insights API requests. */
export function getInsightsApiBase(): string {
  const serverBase = getStaticServerBase();
  return serverBase ? `${serverBase}/api/insights` : '/api/insights';
}

/** Base URL for Zhihu API requests. */
export function getZhihuApiBase(): string {
  const serverBase = getStaticServerBase();
  return serverBase ? `${serverBase}/api/zhihu` : '/api/zhihu';
}

/** Base URL for Moments API requests. */
export function getMomentsApiBase(): string {
  const serverBase = getStaticServerBase();
  return serverBase ? `${serverBase}/api/moments` : '/api/moments';
}

/** Base URL for Qdrant Explorer API requests. */
export function getQdrantApiBase(): string {
  const serverBase = getStaticServerBase();
  return serverBase ? `${serverBase}/api/qdrant` : '/api/qdrant';
}

/** Base URL for Daily Stats API requests. */
export function getStatsApiBase(): string {
  const serverBase = getStaticServerBase();
  return serverBase ? `${serverBase}/api/stats` : '/api/stats';
}
