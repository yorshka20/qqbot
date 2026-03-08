/**
 * Configurable base URL for file API and static output when webui and static file server
 * are deployed separately (e.g. webui on one machine, static server on another on the LAN).
 *
 * Set VITE_STATIC_SERVER_BASE at build time, e.g.:
 *   VITE_STATIC_SERVER_BASE=http://192.168.1.100:3456 bun run build
 * Or in .env:
 *   VITE_STATIC_SERVER_BASE=http://192.168.1.100:3456
 *
 * When unset or empty, defaults to http://localhost:8888 (same as dev proxy target).
 */

const DEFAULT_STATIC_SERVER_BASE = 'http://localhost:8888';

const base = (import.meta.env.VITE_STATIC_SERVER_BASE as string | undefined)?.trim() || DEFAULT_STATIC_SERVER_BASE;

/** Base URL for the static file server (no trailing slash). Defaults to http://localhost:8888. */
export function getStaticServerBase(): string {
  return base.replace(/\/$/, '');
}

/** Base URL for file API requests: getStaticServerBase() + '/api/files'. */
export function getFileApiBase(): string {
  return `${getStaticServerBase()}/api/files`;
}

/** Base URL for output (static) resources: getStaticServerBase() + '/output'. */
export function getOutputBase(): string {
  return `${getStaticServerBase()}/output`;
}
