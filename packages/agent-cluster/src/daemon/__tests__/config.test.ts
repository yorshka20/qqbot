import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRepoRoot } from '@qqbot/shared';
import { loadClusterDaemonConfig, parseClusterDaemonConfig } from '../config';

const minimal = {
  clusterDaemon: { auth: { token: 'secret' } },
  cluster: { enabled: true, workerTemplates: { tpl: { type: 'claude-cli' } }, projects: {} },
  codingAgent: { projectRegistry: { allowedBasePaths: [], defaultProject: 'x', projects: [] } },
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
      clusterDaemon: { ...minimal.clusterDaemon, stateDir: '/tmp/cluster-state', http: { host: '0.0.0.0', port: 4500 } },
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
    expect(() => parseClusterDaemonConfig({ ...minimal, clusterDaemon: { auth: {} } })).toThrow(/auth\.token/);
    expect(() => parseClusterDaemonConfig({ ...minimal, cluster: { enabled: false } })).toThrow(/cluster\.enabled/);
    expect(() =>
      parseClusterDaemonConfig({ ...minimal, clusterDaemon: { ...minimal.clusterDaemon, http: { port: 70000 } } }),
    ).toThrow(/http\.port/);
    expect(() => parseClusterDaemonConfig({ ...minimal, codingAgent: {} })).toThrow(/projectRegistry/);
    expect(() => parseClusterDaemonConfig({ cluster: minimal.cluster })).toThrow(/clusterDaemon/);
  });

  test('worktreeRoot expands ~ and must be absolute', () => {
    const withRoot = (worktreeRoot: string) =>
      parseClusterDaemonConfig({ ...minimal, clusterDaemon: { ...minimal.clusterDaemon, worktreeRoot } });
    expect(withRoot('~/wt').cluster.worktreeRoot).toBe(join(homedir(), 'wt'));
    expect(withRoot('/abs/wt').cluster.worktreeRoot).toBe('/abs/wt');
    expect(() => withRoot('data/wt')).toThrow(/worktreeRoot/);
  });
});

describe('loadClusterDaemonConfig', () => {
  test('merges every .jsonc of a config.d directory by top-level key, with comments and trailing commas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cluster-daemon-config-'));
    writeFileSync(
      join(dir, 'cluster.jsonc'),
      `{
        // comment
        "clusterDaemon": { "auth": { "token": "t", }, },
        "cluster": { "enabled": true, "workerTemplates": {}, "projects": {}, },
      }`,
    );
    writeFileSync(
      join(dir, 'coding-agent.jsonc'),
      `{ "codingAgent": { "projectRegistry": { "allowedBasePaths": [], "defaultProject": "x", "projects": [] } } }`,
    );
    writeFileSync(join(dir, 'tickets.jsonc'), `{ "tickets": { "dir": "${dir}/tickets" } }`);
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    const config = loadClusterDaemonConfig(dir);
    expect(config.auth.token).toBe('t');
    expect(config.tickets.dir).toBe(join(dir, 'tickets'));
    expect(config.projectRegistry.defaultProject).toBe('x');
  });

  test('reads a single config file too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cluster-daemon-config-'));
    const path = join(dir, 'config.jsonc');
    writeFileSync(
      path,
      `{
        "clusterDaemon": { "auth": { "token": "one-file" } },
        "cluster": { "enabled": true, "workerTemplates": {}, "projects": {} },
        "codingAgent": { "projectRegistry": { "allowedBasePaths": [], "defaultProject": "x", "projects": [] } }
      }`,
    );
    expect(loadClusterDaemonConfig(path).auth.token).toBe('one-file');
  });

  test('names the file in a parse error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cluster-daemon-config-'));
    const path = join(dir, 'broken.jsonc');
    writeFileSync(path, '{ "clusterDaemon": ');
    expect(() => loadClusterDaemonConfig(dir)).toThrow(path);
  });
});
