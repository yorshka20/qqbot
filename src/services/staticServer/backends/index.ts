/**
 * Backend registry — creates API backends for **StaticServer**.
 * To add a backend: register in `buildBackendRegistry()` with a stable `id` string.
 *
 * Valid `id` values (for `lanRelay.*.disabledStaticBackends` in config.d):
 *   files, cluster, lan, tickets, reports, insights, moments, zhihu, qdrant, stats, memory, output
 */

import { ClusterAPIBackend } from './ClusterAPIBackend';
import { DailyStatsBackend } from './DailyStatsBackend';
import { FileManagerBackend } from './FileManagerBackend';
import { InsightsBackend } from './InsightsBackend';
import { LanAPIBackend } from './LanAPIBackend';
import { LogsBackend } from './LogsBackend';
import { MemoryStatusBackend } from './MemoryStatusBackend';
import { MomentsBackend } from './MomentsBackend';
import { OutputStaticHost } from './OutputStaticHost';
import { QdrantExplorerBackend } from './QdrantExplorerBackend';
import { ReportBackend } from './ReportBackend';
import { TicketBackend } from './TicketBackend';
import type { Backend } from './types';
import { ZhihuBackend } from './ZhihuBackend';

export type { Backend } from './types';
export { errorResponse, jsonResponse } from './types';

/**
 * Context passed to each backend factory. Extend this (rather than each
 * factory's signature) when a new backend needs injected paths/config.
 */
interface BackendFactoryContext {
  baseDir: string;
  /**
   * Absolute tickets directory (see `TicketsConfig`). Required when the
   * `tickets` backend is enabled. `createBackends` falls back to
   * `<cwd>/tickets` when the caller omits it, preserving pre-externalized
   * behavior for CLI entrypoints that don't load a full Config.
   */
  ticketsDir: string;
}

type BackendFactory = { id: string; create: (ctx: BackendFactoryContext) => Backend };

function buildBackendRegistry(): BackendFactory[] {
  return [
    { id: 'files', create: (ctx) => new FileManagerBackend(ctx.baseDir) },
    { id: 'cluster', create: () => new ClusterAPIBackend() },
    { id: 'lan', create: () => new LanAPIBackend() },
    { id: 'tickets', create: (ctx) => new TicketBackend(ctx.ticketsDir) },
    { id: 'reports', create: () => new ReportBackend() },
    { id: 'insights', create: () => new InsightsBackend() },
    { id: 'moments', create: () => new MomentsBackend() },
    { id: 'zhihu', create: () => new ZhihuBackend() },
    { id: 'qdrant', create: () => new QdrantExplorerBackend() },
    { id: 'stats', create: () => new DailyStatsBackend() },
    { id: 'memory', create: () => new MemoryStatusBackend() },
    { id: 'logs', create: () => new LogsBackend() },
    { id: 'output', create: (ctx) => new OutputStaticHost(ctx.baseDir) },
  ];
}

const registry = buildBackendRegistry();

/**
 * Create backends for **StaticServer**. Order matches registration order (prefix dispatch).
 * @param baseDir - Base directory for file-serving backends.
 * @param options.disabledIds - Backend ids to omit (from `lanRelay.*.disabledStaticBackends`).
 * @param options.ticketsDir - Absolute path for `TicketBackend` storage;
 *   defaults to `<cwd>/tickets` when unset.
 */
export function createBackends(
  baseDir: string,
  options?: { disabledIds?: ReadonlySet<string>; ticketsDir?: string },
): Backend[] {
  const disabled = options?.disabledIds ?? new Set<string>();
  const ctx: BackendFactoryContext = {
    baseDir,
    ticketsDir: options?.ticketsDir ?? `${process.cwd()}/tickets`,
  };
  const out: Backend[] = [];
  for (const entry of registry) {
    if (disabled.has(entry.id)) {
      continue;
    }
    out.push(entry.create(ctx));
  }
  return out;
}
