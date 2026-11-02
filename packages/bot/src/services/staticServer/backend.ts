/**
 * The extension point **StaticServer** mounts: a URL prefix and a handler for it.
 *
 * Every module that answers HTTP requests registers its own backend here, so this
 * package knows nothing about wechat, zhihu, the cluster, memory or persona. The
 * composition root (`core/staticBackends.ts`) is what pulls the owning modules in,
 * and their registrations run at import time.
 */

import type { ErrorResponse } from '@qqbot/api-types';
import { logger } from '@qqbot/shared';
import type { Config } from '@/core/config';

export interface Backend {
  /** URL prefix this backend answers for (e.g. `/api/memory`). */
  readonly prefix: string;
  /** Handle a request. Return a Response if handled, null if not matched. */
  handle(pathname: string, req: Request): Promise<Response | null> | Response | null;
}

/**
 * What a backend may build itself from. A backend that needs configuration pulls its
 * own slice out of `config` (`getTicketsDir()`, `getDocsPreviewConfig()`, …) rather
 * than growing this struct. `config` is absent on call sites without a fully loaded
 * Config (smoke and test paths), so a backend that needs it falls back gracefully.
 */
export interface BackendContext {
  baseDir: string;
  config?: Config;
}

export interface StaticBackendEntry {
  /** Stable id, also what `lanRelay.*.disabledStaticBackends` names to omit it. */
  id: string;
  create: (ctx: BackendContext) => Backend;
}

const entries: StaticBackendEntry[] = [];

/**
 * Register a backend. Called at module scope by the module that owns the routes, the
 * same way tools and commands register themselves. A repeated id keeps the first
 * registration, so a module reload does not duplicate a route.
 */
export function registerStaticBackend(entry: StaticBackendEntry): void {
  if (entries.some((e) => e.id === entry.id)) {
    return;
  }
  entries.push(entry);
}

/** Every registered id, sorted — the valid values for `disabledStaticBackends`. */
export function registeredBackendIds(): string[] {
  return entries.map((e) => e.id).sort();
}

/**
 * Build the registered backends, in id order. `StaticServer` dispatches by prefix, so
 * the order is only safe while no prefix shadows another — this asserts that instead
 * of leaving it to the order the modules happen to be imported in.
 */
export function createRegisteredBackends(
  ctx: BackendContext,
  options?: { disabledIds?: ReadonlySet<string> },
): Backend[] {
  const disabled = options?.disabledIds ?? new Set<string>();
  for (const id of disabled) {
    if (!entries.some((e) => e.id === id)) {
      logger.warn(`[StaticServer] disabledStaticBackends names "${id}", which no backend registers`);
    }
  }

  const built: Backend[] = [];
  for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
    if (disabled.has(entry.id)) {
      continue;
    }
    built.push(entry.create(ctx));
  }

  assertDisjointPrefixes(built);
  return built;
}

/**
 * A request is routed to the first backend whose prefix it is under, so two equal
 * prefixes — or one that is a path-prefix of another — make routing depend on order.
 * Fail at startup rather than silently shadowing a route.
 */
export function assertDisjointPrefixes(built: Backend[]): void {
  for (const a of built) {
    for (const b of built) {
      if (a === b) {
        continue;
      }
      if (a.prefix === b.prefix || b.prefix.startsWith(`${a.prefix}/`)) {
        throw new Error(
          `[StaticServer] backend prefix "${a.prefix}" shadows "${b.prefix}" — prefixes must be disjoint`,
        );
      }
    }
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export function jsonResponse<T extends object>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function errorResponse(message: string, status: number): Response {
  return jsonResponse<ErrorResponse>({ error: message }, status);
}
