import { readFileSync } from 'node:fs';
import { ConfigError, fromRepoRoot, resolveFromRepoRoot } from '@qqbot/shared';
import { type ParseError, parse as parseJsonc } from 'jsonc-parser';
import type { ClusterConfig } from '../cluster/config';
import { parseClusterConfig } from '../cluster/config';
import type { ProjectRegistryConfig, TicketsConfig } from '../config';

export interface ClusterDaemonConfig {
  /** Absolute. Holds `state.sqlite`, `daemon.lock`, worker logs, MCP configs and `ui/`. */
  stateDir: string;
  /** The one port: `/mcp`, `/api/cluster`, `/api/tickets`, `/health` and the static console. */
  http: { host: string; port: number };
  /** Bearer token `/api/*` and `/health` require. */
  auth: { token: string };
  cluster: ClusterConfig;
  projectRegistry: ProjectRegistryConfig;
  /** `dir` is absolute. */
  tickets: TicketsConfig;
}

export const DEFAULT_HTTP_HOST = '0.0.0.0';
export const DEFAULT_HTTP_PORT = 3200;

export function defaultClusterDaemonConfigPath(): string {
  return process.env.CLUSTER_CONFIG_PATH
    ? resolveFromRepoRoot(process.env.CLUSTER_CONFIG_PATH)
    : fromRepoRoot('cluster.jsonc');
}

export function loadClusterDaemonConfig(path: string): ClusterDaemonConfig {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new ConfigError(`cannot read cluster config ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const where = errors.map((e) => `error ${e.error} at offset ${e.offset}`).join(', ');
    throw new ConfigError(`JSONC parse errors in ${path}: ${where}`);
  }
  if (!isRecord(parsed)) {
    throw new ConfigError(`${path} must contain a JSON object`);
  }
  return parseClusterDaemonConfig(parsed, path);
}

/**
 * Build the daemon config from the parsed `cluster.jsonc`. The daemon's `stateDir` and
 * `http` are the only values for the cluster's state directory and its listen address:
 * `cluster.stateDir`, `cluster.hub.port` and `cluster.hub.bindHost` in the file are
 * overridden by them. `cluster.hub.host` stays the loopback address workers connect to.
 */
export function parseClusterDaemonConfig(raw: Record<string, unknown>, source = 'cluster.jsonc'): ClusterDaemonConfig {
  const stateDir =
    typeof raw.stateDir === 'string' && raw.stateDir.trim()
      ? resolveFromRepoRoot(raw.stateDir.trim())
      : fromRepoRoot('data', 'cluster');

  const httpRaw = isRecord(raw.http) ? raw.http : {};
  const host = typeof httpRaw.host === 'string' && httpRaw.host.trim() ? httpRaw.host.trim() : DEFAULT_HTTP_HOST;
  const port = httpRaw.port === undefined ? DEFAULT_HTTP_PORT : httpRaw.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${source}: http.port must be a port number`);
  }

  const authRaw = isRecord(raw.auth) ? raw.auth : {};
  const token = typeof authRaw.token === 'string' ? authRaw.token.trim() : '';
  if (!token) {
    throw new ConfigError(`${source}: auth.token is required (the bot and the console present it as a Bearer token)`);
  }

  if (!isRecord(raw.cluster)) {
    throw new ConfigError(`${source}: cluster block is required`);
  }
  const hubRaw = isRecord(raw.cluster.hub) ? raw.cluster.hub : {};
  const cluster = parseClusterConfig({
    ...raw.cluster,
    stateDir,
    hub: { ...hubRaw, port, bindHost: host },
  });
  if (!cluster) {
    throw new ConfigError(`${source}: cluster.enabled must be true for a daemon to run`);
  }

  if (!isRecord(raw.projectRegistry)) {
    throw new ConfigError(`${source}: projectRegistry block is required`);
  }
  const projectRegistry = raw.projectRegistry as unknown as ProjectRegistryConfig;

  const ticketsRaw = isRecord(raw.tickets) ? raw.tickets : {};
  const ticketsDir =
    typeof ticketsRaw.dir === 'string' && ticketsRaw.dir.trim()
      ? resolveFromRepoRoot(ticketsRaw.dir.trim())
      : fromRepoRoot('tickets');

  return {
    stateDir,
    http: { host, port },
    auth: { token },
    cluster,
    projectRegistry,
    tickets: { dir: ticketsDir },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
