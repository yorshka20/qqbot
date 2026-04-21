/**
 * Two independent base URLs for the WebUI's HTTP backends, because the
 * 14 backends naturally split into two deployment categories:
 *
 *   1. **Shared content** (host is the single source of truth): file
 *      browser, reports, insights, zhihu cache, moments, Qdrant explorer,
 *      memory status, daily stats, output static. These represent
 *      knowledge accumulated by ONE bot (the host) — a client bot on
 *      another machine doesn't have most of this data, so it should
 *      cross-read it from the host. Controlled by `VITE_STATIC_SERVER_BASE`.
 *
 *   2. **Per-machine runtime state**: Agent Cluster, tickets, LAN relay
 *      control, ProjectRegistry. Each bot deployment runs its own cluster,
 *      keeps its own `tickets/` directory, has its own LAN role, and has
 *      its own ProjectRegistry pointing at this machine's local source
 *      paths. These MUST hit the local bot's own backend, never the
 *      host's. Controlled by `VITE_LOCAL_API_BASE` (defaults to empty
 *      = same origin, which is the right default in every deployment
 *      since the WebUI is always served by the same bot that owns the
 *      local state).
 *
 * Both env vars are read at build time. Set them in `.env`, `.env.local`,
 * or as `VITE_X=... bun run build`.
 *
 * Typical configurations:
 *
 *   ## Host bot (single-machine setup)
 *   Both unset → everything is same-origin. Identical to pre-Phase-3 behavior.
 *
 *   ## Client bot reading host content
 *   .env on the client machine:
 *     VITE_STATIC_SERVER_BASE=http://192.168.50.209:8889
 *     # VITE_LOCAL_API_BASE unset (defaults to same-origin)
 *
 *   The client's WebUI then pulls files/reports/insights/etc from the
 *   host (single knowledge source) but reads cluster/tickets/lan/projects
 *   from its own bot at the same origin the WebUI was loaded from.
 *
 *   ## Detached WebUI dev server
 *   Run `bun run dev:webui` against any backend by setting BOTH vars to
 *   the same backend URL — both groups go to that one place.
 */

const sharedContentBase = (import.meta.env.VITE_STATIC_SERVER_BASE as string | undefined)?.trim() || '';
const localApiBase = (import.meta.env.VITE_LOCAL_API_BASE as string | undefined)?.trim() || '';

/**
 * Base URL for the **shared-content** backends (file browser, reports,
 * insights, zhihu, moments, qdrant, memory, stats, output static).
 * Empty string = same origin. Set via `VITE_STATIC_SERVER_BASE` to point
 * a client deployment at a remote host bot.
 */
export function getStaticServerBase(): string {
  return sharedContentBase ? sharedContentBase.replace(/\/$/, '') : '';
}

/**
 * Base URL for the **per-machine** backends (cluster, tickets, LAN,
 * projects). Empty string = same origin (the default — the WebUI is
 * always served by the same bot that owns this machine's local state).
 * Override via `VITE_LOCAL_API_BASE` only for unusual setups like
 * running the WebUI dev server against a remote bot.
 */
export function getLocalApiBase(): string {
  return localApiBase ? localApiBase.replace(/\/$/, '') : '';
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

/** Base URL for Memory Status API requests. */
export function getMemoryApiBase(): string {
  const serverBase = getStaticServerBase();
  return serverBase ? `${serverBase}/api/memory` : '/api/memory';
}

/** Base URL for read-only docs preview (repo `docs/`, `claude-learnings/`, `claude-workbook/`). Uses shared host when `VITE_STATIC_SERVER_BASE` is set. */
export function getDocsApiBase(): string {
  const serverBase = getStaticServerBase();
  return serverBase ? `${serverBase}/api/docs` : '/api/docs';
}

// ── Per-machine backends (use VITE_LOCAL_API_BASE / same-origin) ──
//
// The four helpers below intentionally use `getLocalApiBase()` instead
// of `getStaticServerBase()`. Cluster jobs, ticket markdown files, LAN
// role state, and ProjectRegistry are all per-machine — when a client
// bot loads its own WebUI, these MUST hit the client's own bot, never
// the remote host. Same-origin default (empty `getLocalApiBase()`) is
// what makes this work without any client-side env config.

/**
 * Base URL for all Agent Cluster API requests. Includes the always-on
 * control plane (status / start / stop / templates / projects) plus the
 * gated query routes (workers / jobs / events / etc.) — see
 * src/services/staticServer/backends/ClusterAPIBackend.ts for the full
 * route list. There is no separate `/api/cluster-control` prefix; the
 * control routes live under this base too.
 */
export function getClusterApiBase(): string {
  const serverBase = getLocalApiBase();
  return serverBase ? `${serverBase}/api/cluster` : '/api/cluster';
}

/** Base URL for LAN relay API requests (host mode only — see LanAPIBackend). */
export function getLanApiBase(): string {
  const serverBase = getLocalApiBase();
  return serverBase ? `${serverBase}/api/lan` : '/api/lan';
}

/**
 * Base URL for cluster ticket CRUD (TicketBackend). Tickets live under
 * `tickets/` at the project root and are stored as markdown files; this
 * API is intentionally separate from `/api/cluster/*` because tickets
 * are an input artifact for cluster (and potentially future) workflows,
 * not part of cluster's runtime state.
 */
export function getTicketsApiBase(): string {
  const serverBase = getLocalApiBase();
  return serverBase ? `${serverBase}/api/tickets` : '/api/tickets';
}

/** Base URL for Logs API requests (pm2 log streaming). */
export function getLogsApiBase(): string {
  const serverBase = getLocalApiBase();
  return serverBase ? `${serverBase}/api/logs` : '/api/logs';
}

/** Base URL for Projects API requests (ProjectRegistry). */
export function getProjectsApiBase(): string {
  const serverBase = getLocalApiBase();
  return serverBase ? `${serverBase}/api/cluster/projects` : '/api/cluster/projects';
}
