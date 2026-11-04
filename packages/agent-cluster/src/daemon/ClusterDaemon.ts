import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@qqbot/shared';
import { withBearerToken } from '../api/bearerAuth';
import { ClusterApi } from '../api/clusterApi';
import { type ClusterDaemonHealthResponse, healthRoute } from '../api/healthRoute';
import { staticUiRoute } from '../api/staticUiRoute';
import { TicketApi } from '../api/ticketApi';
import { ClusterManager } from '../cluster/ClusterManager';
import { wireClusterTicketWriteback } from '../cluster/ClusterTicketWriteback';
import type { ProjectRegistry } from '../codingAgent/ProjectRegistry';
import type { ClusterDaemonConfig } from './config';
import { acquireDaemonLock } from './lock';

/**
 * The cluster as its own process: one state directory, one SQLite file, one HTTP server.
 *
 * `start()` takes the state lock, opens the store, builds the `ClusterManager`, binds the
 * server with the REST API, health and console routes mounted beside `/mcp`, and starts the
 * cluster. The server is bound before the cluster starts and stays bound while the cluster
 * is stopped through `POST /api/cluster/stop`, so `/start` can bring it back.
 *
 * `stop()` leaves workers running unless told otherwise: they are detached processes the
 * next daemon adopts by pid.
 */
export class ClusterDaemon {
  private db: Database | null = null;
  private cluster: ClusterManager | null = null;
  private releaseLock: (() => void) | null = null;
  private startedAt: string | null = null;

  constructor(
    private readonly config: ClusterDaemonConfig,
    private readonly projectRegistry: ProjectRegistry,
  ) {}

  async start(): Promise<void> {
    if (this.cluster) {
      return;
    }
    const { stateDir } = this.config;
    mkdirSync(stateDir, { recursive: true });
    this.releaseLock = acquireDaemonLock(join(stateDir, 'daemon.lock'));
    try {
      this.db = openStateDatabase(join(stateDir, 'state.sqlite'));
      const cluster = new ClusterManager(this.config.cluster, this.db, this.projectRegistry, this.config.tickets.dir);
      wireClusterTicketWriteback(cluster);
      this.mountRoutes(cluster);
      this.startedAt = new Date().toISOString();
      cluster.getHub().listen();
      this.cluster = cluster;
      await cluster.start();
      logger.info(
        `[ClusterDaemon] Up: state ${stateDir}, listening on ${this.config.http.host}:${this.config.http.port}`,
      );
    } catch (err) {
      await this.teardown({ killWorkers: false });
      throw err;
    }
  }

  async stop(options?: { killWorkers?: boolean }): Promise<void> {
    if (!this.cluster) {
      return;
    }
    logger.info(`[ClusterDaemon] Stopping${options?.killWorkers ? ' (killing workers)' : ''}...`);
    await this.teardown(options);
    logger.info('[ClusterDaemon] Stopped');
  }

  getClusterManager(): ClusterManager {
    if (!this.cluster) {
      throw new Error('[ClusterDaemon] not started');
    }
    return this.cluster;
  }

  private mountRoutes(cluster: ClusterManager): void {
    const hub = cluster.getHub();
    const { token } = this.config.auth;
    hub.registerRoute(withBearerToken(token, new ClusterApi(cluster, this.projectRegistry)));
    hub.registerRoute(withBearerToken(token, new TicketApi(this.config.tickets.dir)));
    hub.registerRoute(
      withBearerToken(
        token,
        healthRoute(() => this.health(cluster)),
      ),
    );
    hub.registerRoute(staticUiRoute(join(this.config.stateDir, 'ui')));
  }

  private health(cluster: ClusterManager): ClusterDaemonHealthResponse {
    const status = cluster.getStatus();
    return {
      ok: true,
      startedAt: this.startedAt ?? new Date().toISOString(),
      cluster: { running: status.running, paused: status.paused, activeWorkers: status.activeWorkers },
    };
  }

  private async teardown(options?: { killWorkers?: boolean }): Promise<void> {
    const cluster = this.cluster;
    this.cluster = null;
    if (cluster) {
      try {
        await cluster.stop(options);
      } finally {
        cluster.getHub().close();
      }
    }
    this.db?.close();
    this.db = null;
    this.releaseLock?.();
    this.releaseLock = null;
    this.startedAt = null;
  }
}

function openStateDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 5000');
  return db;
}
