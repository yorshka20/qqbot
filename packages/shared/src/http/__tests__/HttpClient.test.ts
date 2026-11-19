// Tests for HttpClient's connection-reuse policy against a server that retires
// a pooled socket mid-request — the failure mode behind "The socket connection
// was closed unexpectedly" on the Milky protocol's send path.

import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { HttpClient } from '../HttpClient';

let server: Server | undefined;

/**
 * Serve one response per TCP connection, then answer any further request on the
 * same socket with a FIN. That is what an Express peer does when its
 * `Keep-Alive: timeout=5` idle timer fires while the client is writing the next
 * request onto the pooled socket.
 */
async function startSocketRetiringServer(): Promise<{ baseURL: string; connectionCount: () => number }> {
  let connections = 0;
  const s = createServer((socket) => {
    connections++;
    let served = 0;
    socket.on('data', (chunk) => {
      if (!chunk.toString().includes('\r\n\r\n')) {
        return;
      }
      served++;
      if (served > 1) {
        socket.end();
        return;
      }
      const body = '{"status":"ok","retcode":0,"data":{"message_seq":7}}';
      socket.write(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n` +
          `Connection: keep-alive\r\nKeep-Alive: timeout=5\r\n\r\n${body}`,
      );
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  server = s;
  const { port } = s.address() as { port: number };
  return { baseURL: `http://127.0.0.1:${port}/api`, connectionCount: () => connections };
}

async function postTimes(client: HttpClient, times: number): Promise<number> {
  let failures = 0;
  for (let i = 0; i < times; i++) {
    try {
      await client.post('/send_group_message', { group_id: 1 });
    } catch {
      failures++;
    }
  }
  return failures;
}

afterEach(() => {
  server?.close();
  server = undefined;
});

describe('HttpClient connection reuse', () => {
  it('fails when a pooled socket is retired by the peer', async () => {
    const { baseURL } = await startSocketRetiringServer();
    const client = new HttpClient({ baseURL, defaultHeaders: { 'Content-Type': 'application/json' } });

    expect(await postTimes(client, 6)).toBeGreaterThan(0);
  });

  it('survives socket retirement when keepAlive is off', async () => {
    const { baseURL, connectionCount } = await startSocketRetiringServer();
    const client = new HttpClient({
      baseURL,
      defaultHeaders: { 'Content-Type': 'application/json' },
      keepAlive: false,
    });

    expect(await postTimes(client, 6)).toBe(0);
    expect(connectionCount()).toBe(6);
  });
});

describe('HttpClient multipart bodies', () => {
  it('sends FormData as multipart even when the client defaults to JSON', async () => {
    let received: { contentType: string | null; purpose: unknown; file: string } | undefined;
    const bunServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const form = await req.formData();
        received = {
          contentType: req.headers.get('content-type'),
          purpose: form.get('purpose'),
          file: await (form.get('file') as Blob).text(),
        };
        return Response.json({ id: 'file_1' });
      },
    });
    try {
      const client = new HttpClient({
        baseURL: `http://127.0.0.1:${bunServer.port}`,
        defaultHeaders: { 'Content-Type': 'application/json' },
      });
      const form = new FormData();
      form.append('purpose', 'batch');
      form.append('file', new Blob(['{"a":1}\n{"b":2}']), 'batch.jsonl');

      expect(await client.post<{ id: string }>('/files', form)).toEqual({ id: 'file_1' });
      expect(received?.contentType).toStartWith('multipart/form-data; boundary=');
      expect(received?.purpose).toBe('batch');
      expect(received?.file).toBe('{"a":1}\n{"b":2}');
    } finally {
      bunServer.stop(true);
    }
  });
});
