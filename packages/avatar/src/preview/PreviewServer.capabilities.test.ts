/**
 * PreviewServer capabilities WS contract tests.
 *
 * Verifies that the server correctly handles renderer capability reports:
 * - validates and cleans incoming payloads
 * - silently drops malformed messages
 * - dispatches onConnectionClosed on WS close
 * - exposes GET /capabilities HTTP endpoint
 *
 * Uses real Bun WS connections to the real server — no mocks.
 */
import { describe, expect, test } from 'bun:test';
import { PreviewServer } from './PreviewServer';
import { CANONICAL_EXPRESSIONS, type RendererCapabilities } from './types';

// High port range to avoid conflicts with other test files.
const TEST_PORT = 48800;

/** Send a single WS message and wait `waitMs` for any side-effect. */
async function sendAndWait(port: number, payload: unknown, waitMs = 80): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/`);
    ws.onopen = () => {
      ws.send(JSON.stringify(payload));
      setTimeout(() => {
        ws.close();
        resolve();
      }, waitMs);
    };
    ws.onerror = () => reject(new Error('WebSocket error'));
  });
}

/** Open a WS, send payload, close, and wait `waitMs` after close. */
async function sendThenClose(port: number, payload: unknown, waitMs = 80): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/`);
    ws.onopen = () => {
      ws.send(JSON.stringify(payload));
      ws.close();
      setTimeout(resolve, waitMs);
    };
    ws.onerror = () => reject(new Error('WebSocket error'));
  });
}

// ---------------------------------------------------------------------------
// Canonical expressions array shape
// ---------------------------------------------------------------------------
describe('CANONICAL_EXPRESSIONS', () => {
  test('has exactly 18 entries', () => {
    expect(CANONICAL_EXPRESSIONS.length).toBe(18);
  });

  test('includes happy, aa, blink, lookUp', () => {
    expect(CANONICAL_EXPRESSIONS).toContain('happy');
    expect(CANONICAL_EXPRESSIONS).toContain('aa');
    expect(CANONICAL_EXPRESSIONS).toContain('blink');
    expect(CANONICAL_EXPRESSIONS).toContain('lookUp');
  });
});

// ---------------------------------------------------------------------------
// capabilities WS message dispatch
// ---------------------------------------------------------------------------
describe('PreviewServer capabilities WS handler', () => {
  // -------------------------------------------------------------------------
  // Test a — valid payload calls onCapabilities with cleaned data
  // -------------------------------------------------------------------------
  test('valid capabilities payload calls onCapabilities with cleaned data', async () => {
    const received: RendererCapabilities[] = [];
    const server = new PreviewServer(
      { port: TEST_PORT },
      {
        onCapabilities: (caps) => received.push(caps),
      },
    );
    await server.start();

    const payload = {
      type: 'capabilities',
      data: {
        expressions: ['happy', 'sad', 'aa'],
        supportedChannels: ['head.x', 'body.z'],
        customExpressions: ['mouth_grin_custom'],
        modelId: { kind: 'vrm', slug: 'my-avatar', title: 'My Avatar' },
      },
    };
    await sendAndWait(TEST_PORT, payload);

    expect(received).toHaveLength(1);
    expect(received[0].expressions).toEqual(['happy', 'sad', 'aa']);
    expect(received[0].supportedChannels).toEqual(['head.x', 'body.z']);
    expect(received[0].customExpressions).toEqual(['mouth_grin_custom']);
    expect(received[0].modelId).toEqual({ kind: 'vrm', slug: 'my-avatar', title: 'My Avatar' });

    await server.stop();
  });

  // -------------------------------------------------------------------------
  // Test b — unknown expressions filtered out (e.g. 'mouth_grin')
  // -------------------------------------------------------------------------
  test('unknown expressions are filtered out of cleaned data', async () => {
    const received: RendererCapabilities[] = [];
    const server = new PreviewServer(
      { port: TEST_PORT + 1 },
      {
        onCapabilities: (caps) => received.push(caps),
      },
    );
    await server.start();

    const payload = {
      type: 'capabilities',
      data: {
        expressions: ['happy', 'mouth_grin', 'aa', 'UNKNOWN_EXPR'],
        supportedChannels: [],
        customExpressions: [],
        modelId: { kind: 'cubism', slug: 'test-model' },
      },
    };
    await sendAndWait(TEST_PORT + 1, payload);

    expect(received).toHaveLength(1);
    // 'mouth_grin' and 'UNKNOWN_EXPR' should have been filtered out
    expect(received[0].expressions).toEqual(['happy', 'aa']);

    await server.stop();
  });

  // -------------------------------------------------------------------------
  // Test c — missing modelId silently dropped
  // -------------------------------------------------------------------------
  test('missing modelId is silently dropped', async () => {
    const received: RendererCapabilities[] = [];
    const server = new PreviewServer(
      { port: TEST_PORT + 2 },
      {
        onCapabilities: (caps) => received.push(caps),
      },
    );
    await server.start();

    await sendAndWait(TEST_PORT + 2, {
      type: 'capabilities',
      data: {
        expressions: ['happy'],
        supportedChannels: [],
        customExpressions: [],
        // modelId intentionally omitted
      },
    });

    expect(received).toHaveLength(0);

    await server.stop();
  });

  // -------------------------------------------------------------------------
  // Test d — wrong expressions type (non-array) is silently dropped
  // -------------------------------------------------------------------------
  test('wrong expressions type (string instead of array) is silently dropped', async () => {
    const received: RendererCapabilities[] = [];
    const server = new PreviewServer(
      { port: TEST_PORT + 3 },
      {
        onCapabilities: (caps) => received.push(caps),
      },
    );
    await server.start();

    await sendAndWait(TEST_PORT + 3, {
      type: 'capabilities',
      data: {
        expressions: 'happy', // should be an array
        supportedChannels: [],
        customExpressions: [],
        modelId: { kind: 'vrm', slug: 'test' },
      },
    });

    expect(received).toHaveLength(0);

    await server.stop();
  });

  // -------------------------------------------------------------------------
  // Test e — invalid modelId.kind is silently dropped
  // -------------------------------------------------------------------------
  test('invalid modelId.kind is silently dropped', async () => {
    const received: RendererCapabilities[] = [];
    const server = new PreviewServer(
      { port: TEST_PORT + 4 },
      {
        onCapabilities: (caps) => received.push(caps),
      },
    );
    await server.start();

    await sendAndWait(TEST_PORT + 4, {
      type: 'capabilities',
      data: {
        expressions: ['happy'],
        supportedChannels: [],
        customExpressions: [],
        modelId: { kind: 'unknown-format', slug: 'test' },
      },
    });

    expect(received).toHaveLength(0);

    await server.stop();
  });

  // -------------------------------------------------------------------------
  // Test f — modelId.title absent → undefined in cleaned data (no crash)
  // -------------------------------------------------------------------------
  test('modelId without title is accepted and title is undefined in cleaned data', async () => {
    const received: RendererCapabilities[] = [];
    const server = new PreviewServer(
      { port: TEST_PORT + 5 },
      {
        onCapabilities: (caps) => received.push(caps),
      },
    );
    await server.start();

    await sendAndWait(TEST_PORT + 5, {
      type: 'capabilities',
      data: {
        expressions: [],
        supportedChannels: [],
        customExpressions: [],
        modelId: { kind: 'cubism', slug: 'no-title-model' },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0].modelId.title).toBeUndefined();

    await server.stop();
  });
});

// ---------------------------------------------------------------------------
// close invokes onConnectionClosed
// ---------------------------------------------------------------------------
describe('PreviewServer WS close', () => {
  test('close invokes onConnectionClosed with the WebSocket', async () => {
    const closed: unknown[] = [];
    const server = new PreviewServer(
      { port: TEST_PORT + 6 },
      {
        onConnectionClosed: (ws) => closed.push(ws),
      },
    );
    await server.start();

    await sendThenClose(TEST_PORT + 6, { type: 'trigger', data: { action: 'noop' } }, 80);

    // At least one close event should have fired
    expect(closed.length).toBeGreaterThanOrEqual(1);

    await server.stop();
  });
});

// ---------------------------------------------------------------------------
// GET /capabilities HTTP endpoint
// ---------------------------------------------------------------------------
describe('PreviewServer GET /capabilities', () => {
  // -------------------------------------------------------------------------
  // Test a — absent handler returns 404
  // -------------------------------------------------------------------------
  test('returns 404 when getConnectedCapabilities handler is absent', async () => {
    const server = new PreviewServer({ port: TEST_PORT + 7 }, {});
    await server.start();

    const res = await fetch(`http://localhost:${TEST_PORT + 7}/capabilities`);
    expect(res.status).toBe(404);

    await server.stop();
  });

  // -------------------------------------------------------------------------
  // Test b — present handler returns JSON from the handler
  // -------------------------------------------------------------------------
  test('returns JSON from getConnectedCapabilities handler', async () => {
    const snapshot = [
      {
        remoteAddr: '127.0.0.1:12345',
        caps: {
          expressions: ['happy'] as RendererCapabilities['expressions'],
          supportedChannels: ['head.x'],
          customExpressions: [],
          modelId: { kind: 'vrm' as const, slug: 'my-avatar' },
        },
        receivedAt: '2026-04-22T00:00:00.000Z',
      },
    ];

    const server = new PreviewServer(
      { port: TEST_PORT + 8 },
      {
        getConnectedCapabilities: () => snapshot,
      },
    );
    await server.start();

    const res = await fetch(`http://localhost:${TEST_PORT + 8}/capabilities`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = await res.json();
    expect(body).toEqual(snapshot);

    await server.stop();
  });
});
