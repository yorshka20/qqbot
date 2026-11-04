// ClusterClient against a fake daemon: the bearer token, JSON calls and their errors, the SSE
// stream with its reconnection, and the proxy pass-through.

import 'reflect-metadata';
import { afterEach, describe, expect, test } from 'bun:test';
import type { ClusterStatusResponse } from '@qqbot/api-types';
import type { Config } from '@/core/config';
import { type ClusterEvent, ClusterClient, ClusterClientError, readEventStream } from '../ClusterClient';

const TOKEN = 'secret-token';

interface FakeDaemon {
  url: string;
  requests: Request[];
  bodies: string[];
  stop(): void;
}

function startDaemon(handler: (req: Request, path: string) => Response | Promise<Response>): FakeDaemon {
  const requests: Request[] = [];
  const bodies: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      requests.push(req.clone());
      bodies.push(await req.clone().text());
      if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return handler(req, new URL(req.url).pathname);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    bodies,
    stop: () => server.stop(true),
  };
}

function clientFor(url: string, token = TOKEN): ClusterClient {
  const config = { getClusterClientConfig: () => ({ url, token }) } as unknown as Config;
  return new ClusterClient(config);
}

const STATUS: ClusterStatusResponse = {
  started: true,
  status: {
    running: true,
    paused: false,
    activeWorkers: 1,
    idleWorkers: 0,
    pendingTasks: 2,
    runningTasks: 1,
    completedTasks: 3,
    failedTasks: 0,
    workers: [],
    worktrees: [],
  },
};

const daemons: FakeDaemon[] = [];
afterEach(() => {
  for (const daemon of daemons) {
    daemon.stop();
  }
  daemons.length = 0;
});

function daemon(handler: Parameters<typeof startDaemon>[0]): FakeDaemon {
  const d = startDaemon(handler);
  daemons.push(d);
  return d;
}

describe('ClusterClient JSON calls', () => {
  test('sends the bearer token and parses the response', async () => {
    const d = daemon((_req, path) => (path === '/api/cluster/status' ? Response.json(STATUS) : new Response('', { status: 404 })));
    const client = clientFor(`${d.url}/`);
    expect(await client.getStatus()).toEqual(STATUS);
    expect(await client.isStarted()).toBe(true);
    expect(d.requests[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  test('posts JSON bodies and reads the daemon error message on failure', async () => {
    const d = daemon((req, path) => {
      if (path === '/api/cluster/jobs' && req.method === 'POST') {
        return Response.json({ error: 'unknown project' }, { status: 400 });
      }
      return Response.json({ answered: true });
    });
    const client = clientFor(d.url);
    await expect(client.submitTask('nope', 'do things', { ticketId: 't1' })).rejects.toThrow('unknown project');
    expect(JSON.parse(d.bodies[0])).toEqual({ project: 'nope', description: 'do things', ticketId: 't1' });
    expect(await client.answerHelpRequest('ask 1', 'yes', 'qq:10000001')).toBe(true);
    expect(new URL(d.requests[1].url).pathname).toBe('/api/cluster/help/ask%201/answer');
    expect(JSON.parse(d.bodies[1])).toEqual({ answer: 'yes', answeredBy: 'qq:10000001' });
  });

  test('turns a 404 into null for lookups and keeps other statuses as errors', async () => {
    const d = daemon((_req, path) =>
      path === '/api/cluster/jobs/missing' ? Response.json({ error: 'Job not found' }, { status: 404 }) : new Response('boom', { status: 500 }),
    );
    const client = clientFor(d.url);
    expect(await client.getJob('missing')).toBeNull();
    const err = await client.getTicket('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClusterClientError);
    expect((err as ClusterClientError).status).toBe(500);
  });

  test('reports an unreachable daemon with a null status', async () => {
    const d = daemon(() => Response.json({}));
    const url = d.url;
    d.stop();
    const err = await clientFor(url)
      .getStatus()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClusterClientError);
    expect((err as ClusterClientError).status).toBeNull();
    expect((err as Error).message).toContain('unreachable');
  });

  test('rejects with the daemon status when the token is wrong', async () => {
    const d = daemon(() => Response.json(STATUS));
    const err = await clientFor(d.url, 'wrong')
      .getStatus()
      .catch((e: unknown) => e);
    expect((err as ClusterClientError).status).toBe(401);
  });
});

describe('readEventStream', () => {
  test('splits blocks, names events, joins data lines and parses JSON', async () => {
    const chunks = [
      'event: init\ndata: {"workers":[]}\n\n',
      ': comment\nevent: help_request\r\ndata: {"askId":',
      '"a1"}\r\n\r\ndata: plain\ndata: text\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });
    const events: ClusterEvent[] = [];
    await readEventStream(body, (e) => events.push(e), new AbortController().signal);
    expect(events).toEqual([
      { event: 'init', data: { workers: [] } },
      { event: 'help_request', data: { askId: 'a1' } },
      { event: 'message', data: 'plain\ntext' },
    ]);
  });
});

describe('ClusterClient events', () => {
  test('delivers stream events, runs onConnect per connection, and stops on abort', async () => {
    let connections = 0;
    const d = daemon((_req, path) => {
      if (path !== '/api/cluster/stream') {
        return new Response('', { status: 404 });
      }
      connections += 1;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: init\ndata: {"workers":[]}\n\nevent: help_request\ndata: {"askId":"a1"}\n\n'));
          // The stream stays open until the client goes away.
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    });
    const client = clientFor(d.url);
    const abort = new AbortController();
    const events: ClusterEvent[] = [];
    let connects = 0;
    const done = client.events((e) => events.push(e), abort.signal, () => connects++);
    await waitFor(() => events.length === 2);
    expect(events.map((e) => e.event)).toEqual(['init', 'help_request']);
    expect(connects).toBe(1);
    expect(connections).toBe(1);
    abort.abort();
    await done;
  });

  // The client retries every 5s, so the connection shows up on the second attempt at the earliest.
  test(
    'survives a daemon that is down and connects once it comes up',
    async () => {
    const d = daemon(() => Response.json({}));
    const url = d.url;
    const port = Number(new URL(url).port);
    d.stop();
    daemons.length = 0;

    const client = clientFor(url);
    const abort = new AbortController();
    const events: ClusterEvent[] = [];
    const done = client.events((e) => events.push(e), abort.signal);
    await Bun.sleep(200);
    expect(events).toEqual([]);

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: init\ndata: {}\n\n'));
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    try {
      await waitFor(() => events.length === 1, 8000);
      expect(events[0]).toEqual({ event: 'init', data: {} });
    } finally {
      abort.abort();
      await done;
      server.stop(true);
    }
  },
    15_000,
  );
});

describe('ClusterClient proxy', () => {
  test('forwards method, path, query, body and the token, and returns the daemon response', async () => {
    const d = daemon(async (req, path) => {
      if (req.method === 'PUT' && path === '/api/tickets/t-1') {
        return Response.json({ echoed: await req.json(), query: new URL(req.url).search }, { status: 201 });
      }
      return Response.json({ error: 'nope' }, { status: 404 });
    });
    const client = clientFor(d.url);
    const incoming = new Request('http://bot.local/api/tickets/t-1?x=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'ready' }),
    });
    const res = await client.proxy(incoming, '/api/tickets/t-1?x=1');
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ echoed: { status: 'ready' }, query: '?x=1' });
    expect(d.requests[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  test('streams an SSE response through unchanged', async () => {
    const d = daemon(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: init\ndata: {}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    });
    const client = clientFor(d.url);
    const res = await client.proxy(new Request('http://bot.local/api/cluster/stream'), '/api/cluster/stream');
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('event: init\ndata: {}\n\n');
  });

  test('answers 503 when the daemon is unreachable', async () => {
    const d = daemon(() => Response.json({}));
    const url = d.url;
    d.stop();
    const res = await clientFor(url).proxy(new Request('http://bot.local/api/cluster/status'), '/api/cluster/status');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain('unreachable');
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }
    await Bun.sleep(20);
  }
}
