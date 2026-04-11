/**
 * Backend registry — creates all API backends for the static file server.
 * To add a new backend: create a file in this directory, then add it to createBackends().
 */

import { ClusterAPIBackend } from './ClusterAPIBackend';
import { ClusterControlBackend } from './ClusterControlBackend';
import { DailyStatsBackend } from './DailyStatsBackend';
import { FileManagerBackend } from './FileManagerBackend';
import { InsightsBackend } from './InsightsBackend';
import { MemoryStatusBackend } from './MemoryStatusBackend';
import { MomentsBackend } from './MomentsBackend';
import { OutputStaticHost } from './OutputStaticHost';
import { QdrantExplorerBackend } from './QdrantExplorerBackend';
import { ReportBackend } from './ReportBackend';
import type { Backend } from './types';
import { ZhihuBackend } from './ZhihuBackend';

export type { Backend } from './types';
export { errorResponse, jsonResponse } from './types';

/**
 * Create all backends. Called once during server initialization.
 * @param baseDir - Base directory for file-serving backends.
 */
export function createBackends(baseDir: string): Backend[] {
  return [
    new FileManagerBackend(baseDir),
    new ClusterAPIBackend(),
    new ClusterControlBackend(),
    new ReportBackend(),
    new InsightsBackend(),
    new MomentsBackend(),
    new ZhihuBackend(),
    new QdrantExplorerBackend(),
    new DailyStatsBackend(),
    new MemoryStatusBackend(),
    new OutputStaticHost(baseDir),
  ];
}
