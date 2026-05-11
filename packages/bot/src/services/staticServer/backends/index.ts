/**
 * Backend registry — creates API backends for **StaticServer**.
 * To add a backend: register in `buildBackendRegistry()` with a stable `id` string.
 *
 * Valid `id` values (for `lanRelay.*.disabledStaticBackends` in config.d):
 *   files, cluster, lan, tickets, reports, insights, moments, zhihu, qdrant, stats, memory, output, docs, logs
 */

import { join } from 'node:path';
import type { Config } from '@/core/config';
import { getRepoRoot } from '@/utils/repoRoot';
import { ClusterAPIBackend } from './ClusterAPIBackend';
import { DailyStatsBackend } from './DailyStatsBackend';
import { DocsPreviewBackend } from './DocsPreviewBackend';
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
 * Context passed to each backend factory. Backends that need configuration
 * pull their own slice from `ctx.config` (e.g. `ctx.config.getTicketsDir()`,
 * `ctx.config.getDocsPreviewConfig()`) instead of growing this struct each
 * time. `config` is optional so call sites without a fully-loaded Config
 * (smoke/test paths) still work — backends should fall back gracefully.
 */
interface BackendFactoryContext {
  baseDir: string;
  config?: Config;
}

type BackendFactory = { id: string; create: (ctx: BackendFactoryContext) => Backend };

function buildBackendRegistry(): BackendFactory[] {
  return [
    { id: 'files', create: (ctx) => new FileManagerBackend(ctx.baseDir) },
    { id: 'cluster', create: () => new ClusterAPIBackend() },
    { id: 'lan', create: () => new LanAPIBackend() },
    {
      id: 'tickets',
      create: (ctx) => new TicketBackend(ctx.config?.getTicketsDir() ?? join(getRepoRoot(), 'tickets')),
    },
    { id: 'reports', create: () => new ReportBackend() },
    { id: 'insights', create: () => new InsightsBackend() },
    { id: 'moments', create: () => new MomentsBackend() },
    { id: 'zhihu', create: () => new ZhihuBackend() },
    { id: 'qdrant', create: () => new QdrantExplorerBackend() },
    { id: 'stats', create: () => new DailyStatsBackend() },
    { id: 'memory', create: () => new MemoryStatusBackend() },
    { id: 'logs', create: () => new LogsBackend() },
    { id: 'docs', create: (ctx) => new DocsPreviewBackend(ctx.config?.getDocsPreviewConfig()) },
    { id: 'output', create: (ctx) => new OutputStaticHost(ctx.baseDir) },
  ];
}

const registry = buildBackendRegistry();

/**
 * Create backends for **StaticServer**. Order matches registration order (prefix dispatch).
 * @param baseDir - Base directory for file-serving backends.
 * @param options.disabledIds - Backend ids to omit (from `lanRelay.*.disabledStaticBackends`).
 * @param options.config - Bot config; backends pull their own slice. When
 *   omitted, backends that need config use safe defaults (e.g. `TicketBackend`
 *   falls back to `<repoRoot>/tickets`).
 */
export function createBackends(
  baseDir: string,
  options?: { disabledIds?: ReadonlySet<string>; config?: Config },
): Backend[] {
  const disabled = options?.disabledIds ?? new Set<string>();
  const ctx: BackendFactoryContext = {
    baseDir,
    config: options?.config,
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
