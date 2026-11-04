import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClusterConfig } from '../../cluster/config';
import { ContextHub, isLoopbackAddress } from '../../cluster/hub/ContextHub';
import { withBearerToken } from '../bearerAuth';
import { healthRoute } from '../healthRoute';
import { jsonResponse } from '../http';
import { staticUiRoute } from '../staticUiRoute';

const TOKEN = 'test-token';
let hub: ContextHub;
let base: string;
let db: Database;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'cluster-hub-routes-'));
  db = new Database(':memory:');
  for (const table of ['cluster_events', 'cluster_locks', 'cluster_messages', 'cluster_workers', 'cluster_help_requests']) {
    db.run(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, seq INTEGER, timestamp INTEGER, createdAt TEXT, type TEXT,
      sourceWorkerId TEXT, targetWorkerId TEXT, data TEXT, jobId TEXT, taskId TEXT, filePath TEXT, workerId TEXT,
      claimedAt INTEGER, lastRenewed INTEGER, ttl INTEGER, sender TEXT, content TEXT, priority TEXT, read INTEGER,
      role TEXT, project TEXT, templateName TEXT, status TEXT, registeredAt TEXT, lastSeen TEXT, exitedAt TEXT,
      syncCursor INTEGER, lastHubReportAt TEXT, lastReportSummary TEXT, lastReportNextSteps TEXT, lastReportStatus TEXT,
      tasksCompleted INTEGER, tasksFailed INTEGER, totalReports INTEGER, question TEXT, context TEXT, options TEXT,
      answer TEXT, answeredBy TEXT, answeredAt TEXT)`);
  }
  const config = parseClusterConfig({
    enabled: true,
    stateDir: dir,
    hub: { port: freePort(), host: '127.0.0.1' },
    workerTemplates: {},
    projects: {},
  });
  if (!config) throw new Error('config');
  hub = new ContextHub(config, db, join(dir, 'tickets'));

  hub.registerRoute(
    withBearerToken(TOKEN, {
      prefix: '/api/echo',
      handle: (pathname) => (pathname === '/api/echo/none' ? null : jsonResponse({ pathname })),
    }),
  );
  hub.registerRoute(withBearerToken(TOKEN, healthRoute(() => ({ ok: true, startedAt: 'now', cluster: { running: true, paused: false, activeWorkers: 0 } }))));
  const ui = join(dir, 'ui');
  mkdirSync(join(ui, 'assets'), { recursive: true });
  writeFileSync(join(ui, 'index.html'), '<html>console</html>');
  writeFileSync(join(ui, 'assets', 'app.js'), 'console.log(1)');
  hub.registerRoute(staticUiRoute(ui));

  base = hub.listen();
});

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (!port) {
    throw new Error('no free port');
  }
  return port;
}

afterAll(async () => {
  await hub.stop();
  hub.close();
  db.close();
});

const auth = { Authorization: `Bearer ${TOKEN}` };

describe('hub routes', () => {
  test('/api/* and /health need the bearer token', async () => {
    expect((await fetch(`${base}/api/echo/x`)).status).toBe(401);
    expect((await fetch(`${base}/health`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    const ok = await fetch(`${base}/api/echo/x`, { headers: auth });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ pathname: '/api/echo/x' });
    const health = await fetch(`${base}/health`, { headers: auth });
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
  });

  test('a handler returning null falls through to 404', async () => {
    expect((await fetch(`${base}/api/echo/none`, { headers: auth })).status).toBe(404);
  });

  test('a prefix does not match its own extension', async () => {
    expect((await fetch(`${base}/api/echoes`, { headers: auth })).status).toBe(404);
  });

  test('the console is served at / without a token, with an SPA fallback', async () => {
    expect(await (await fetch(`${base}/`)).text()).toBe('<html>console</html>');
    expect(await (await fetch(`${base}/assets/app.js`)).text()).toBe('console.log(1)');
    const navigation = await fetch(`${base}/tickets/2026-01-01-x`, { headers: { Accept: 'text/html,*/*' } });
    expect(await navigation.text()).toBe('<html>console</html>');
    expect((await fetch(`${base}/tickets/2026-01-01-x`)).status).toBe(404);
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
  });

  test('/mcp is reachable from loopback without a token', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      }),
    });
    expect(res.status).toBe(200);
  });

  test('registering a prefix twice throws', () => {
    expect(() => hub.registerRoute({ prefix: '/health', handle: () => null })).toThrow(/already registered/);
  });
});

describe('isLoopbackAddress', () => {
  test('accepts 127/8 and ::1, also IPv4-mapped', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.1.2.3')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.2')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
