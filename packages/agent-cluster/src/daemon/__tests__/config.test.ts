import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRepoRoot } from '@qqbot/shared';
import { loadClusterDaemonConfig, parseClusterDaemonConfig } from '../config';

const minimal = {
  auth: { token: 'secret' },
  cluster: { enabled: true, workerTemplates: { tpl: { type: 'claude-cli' } }, projects: {} },
  projectRegistry: { allowedBasePaths: [], defaultProject: 'x', projects: [] },
};

describe('parseClusterDaemonConfig', () => {
  test('applies the defaults: data/cluster, 0.0.0.0:3200, <repoRoot>/tickets', () => {
    const config = parseClusterDaemonConfig(minimal);
    expect(config.stateDir).toBe(join(getRepoRoot(), 'data', 'cluster'));
    expect(config.http).toEqual({ host: '0.0.0.0', port: 3200 });
    expect(config.tickets.dir).toBe(join(getRepoRoot(), 'tickets'));
    expect(config.auth.token).toBe('secret');
  });

  test('the daemon stateDir and http address override the cluster block, workers keep loopback', () => {
    const config = parseClusterDaemonConfig({
      ...minimal,
      stateDir: '/tmp/cluster-state',
      http: { host: '0.0.0.0', port: 4500 },
      cluster: { ...minimal.cluster, stateDir: '/elsewhere', hub: { port: 9, bindHost: '10.0.0.1', lockTTL: '1m' } },
    });
    expect(config.stateDir).toBe('/tmp/cluster-state');
    expect(config.cluster.stateDir).toBe('/tmp/cluster-state');
    expect(config.cluster.hub.port).toBe(4500);
    expect(config.cluster.hub.bindHost).toBe('0.0.0.0');
    expect(config.cluster.hub.host).toBe('127.0.0.1');
    expect(config.cluster.hub.lockTTL).toBe(60_000);
  });

  test('rejects a missing token, a disabled cluster and a bad port', () => {
    expect(() => parseClusterDaemonConfig({ ...minimal, auth: {} })).toThrow(/auth\.token/);
    expect(() => parseClusterDaemonConfig({ ...minimal, cluster: { enabled: false } })).toThrow(/cluster\.enabled/);
    expect(() => parseClusterDaemonConfig({ ...minimal, http: { port: 70000 } })).toThrow(/http\.port/);
    expect(() => parseClusterDaemonConfig({ ...minimal, projectRegistry: undefined })).toThrow(/projectRegistry/);
  });
});

describe('loadClusterDaemonConfig', () => {
  test('reads JSONC with comments and trailing commas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cluster-daemon-config-'));
    const path = join(dir, 'cluster.jsonc');
    writeFileSync(
      path,
      `{
        // comment
        "auth": { "token": "t", },
        "cluster": { "enabled": true, "workerTemplates": {}, "projects": {}, },
        "projectRegistry": { "allowedBasePaths": [], "defaultProject": "x", "projects": [] },
        "tickets": { "dir": "${dir}/tickets" },
      }`,
    );
    const config = loadClusterDaemonConfig(path);
    expect(config.auth.token).toBe('t');
    expect(config.tickets.dir).toBe(join(dir, 'tickets'));
  });

  test('names the file in a parse error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cluster-daemon-config-'));
    const path = join(dir, 'cluster.jsonc');
    writeFileSync(path, '{ "auth": ');
    expect(() => loadClusterDaemonConfig(path)).toThrow(path);
  });
});
