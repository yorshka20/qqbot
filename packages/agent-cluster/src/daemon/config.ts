import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ConfigError, fromRepoRoot, resolveFromRepoRoot } from '@qqbot/shared';
import { type ParseError, parse as parseJsonc } from 'jsonc-parser';
import type { ClusterConfig } from '../cluster/config';
import { parseClusterConfig } from '../cluster/config';
import type { ProjectRegistryConfig, TicketsConfig } from '../config';

export interface ClusterDaemonConfig {
  /** Absolute. Holds `state.sqlite`, `daemon.lock`, worker logs, MCP configs and `ui/`; worktrees are in `cluster.worktreeRoot`. */
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

/**
 * The daemon reads the same configuration tree as the bot, resolved the same way:
 * `CONFIG_PATH`, then `<repoRoot>/config.d/`, then `<repoRoot>/config.jsonc`.
 */
export function defaultClusterDaemonConfigPath(): string {
  const candidates = [
    process.env.CONFIG_PATH ? resolveFromRepoRoot(process.env.CONFIG_PATH) : undefined,
    fromRepoRoot('config.d'),
    fromRepoRoot('config.jsonc'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  throw new ConfigError('Config not found: set CONFIG_PATH, or create config.d/ or config.jsonc in the repo root');
}

/** Load the config tree from a `config.d/` directory (every `.jsonc`, merged by top-level key) or one file. */
export function loadClusterDaemonConfig(path: string): ClusterDaemonConfig {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (err) {
    throw new ConfigError(`cannot read config ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!stat.isDirectory()) {
    return parseClusterDaemonConfig(readJsoncObject(path), path);
  }
  const files = readdirSync(path)
    .filter((f) => extname(f).toLowerCase() === '.jsonc')
    .sort();
  if (files.length === 0) {
    throw new ConfigError(`${path} contains no .jsonc files`);
  }
  const merged: Record<string, unknown> = {};
  for (const file of files) {
    Object.assign(merged, readJsoncObject(join(path, file)));
  }
  return parseClusterDaemonConfig(merged, path);
}

function readJsoncObject(path: string): Record<string, unknown> {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new ConfigError(`cannot read config ${path}: ${err instanceof Error ? err.message : String(err)}`);
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
  return parsed;
}

/**
 * Build the daemon config from the merged config tree: `clusterDaemon` (state directory,
 * listen address, token), `cluster`, `codingAgent.projectRegistry` (or a top-level
 * `projectRegistry`) and `tickets`. `clusterDaemon.stateDir` and `clusterDaemon.http` are the
 * only values for the cluster's state directory and its listen address: `cluster.stateDir`,
 * `cluster.hub.port` and `cluster.hub.bindHost` are overridden by them. `cluster.hub.host`
 * stays the loopback address workers connect to.
 */
export function parseClusterDaemonConfig(raw: Record<string, unknown>, source = 'config.d'): ClusterDaemonConfig {
  if (!isRecord(raw.clusterDaemon)) {
    throw new ConfigError(`${source}: clusterDaemon block is required (at least clusterDaemon.auth.token)`);
  }
  const daemon = raw.clusterDaemon;

  const stateDir =
    typeof daemon.stateDir === 'string' && daemon.stateDir.trim()
      ? resolveFromRepoRoot(daemon.stateDir.trim())
      : fromRepoRoot('data', 'cluster');

  const worktreeRoot = typeof daemon.worktreeRoot === 'string' ? daemon.worktreeRoot.trim() : '';

  const httpRaw = isRecord(daemon.http) ? daemon.http : {};
  const host = typeof httpRaw.host === 'string' && httpRaw.host.trim() ? httpRaw.host.trim() : DEFAULT_HTTP_HOST;
  const port = httpRaw.port === undefined ? DEFAULT_HTTP_PORT : httpRaw.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${source}: clusterDaemon.http.port must be a port number`);
  }

  const authRaw = isRecord(daemon.auth) ? daemon.auth : {};
  const token = typeof authRaw.token === 'string' ? authRaw.token.trim() : '';
  if (!token) {
    throw new ConfigError(
      `${source}: clusterDaemon.auth.token is required (the bot and the console present it as a Bearer token)`,
    );
  }

  if (!isRecord(raw.cluster)) {
    throw new ConfigError(`${source}: cluster block is required`);
  }
  const hubRaw = isRecord(raw.cluster.hub) ? raw.cluster.hub : {};
  const cluster = parseClusterConfig({
    ...raw.cluster,
    stateDir,
    ...(worktreeRoot ? { worktreeRoot } : {}),
    hub: { ...hubRaw, port, bindHost: host },
  });
  if (!cluster) {
    throw new ConfigError(`${source}: cluster.enabled must be true for a daemon to run`);
  }

  const codingAgent = isRecord(raw.codingAgent) ? raw.codingAgent : {};
  const registryRaw = isRecord(codingAgent.projectRegistry) ? codingAgent.projectRegistry : raw.projectRegistry;
  if (!isRecord(registryRaw)) {
    throw new ConfigError(`${source}: codingAgent.projectRegistry (or projectRegistry) block is required`);
  }
  const projectRegistry = registryRaw as unknown as ProjectRegistryConfig;

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
