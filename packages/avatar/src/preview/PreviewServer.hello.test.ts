/**
 * PreviewServer hello-handshake WS contract tests.
 *
 * Verifies that the server dispatches valid hello messages to the
 * onModelKindChange handler, and silently warns+drops invalid ones.
 *
 * Uses real WS connections to the real Bun server — no mocks.
 */
import { describe, expect, test } from 'bun:test';
import { PreviewServer } from './PreviewServer';
import type { ModelKind } from './types';

// High port range to avoid conflicts with other test files.
const TEST_PORT = 48790;

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
    ws.onerror = () => {
      reject(new Error('WebSocket error'));
    };
  });
}

describe('PreviewServer hello handshake', () => {
  // -------------------------------------------------------------------------
  // Test a — valid hello 'cubism' dispatched to handler
  // -------------------------------------------------------------------------
  test('valid hello with modelKind=cubism calls onModelKindChange', async () => {
    const received: (ModelKind | null)[] = [];
    const server = new PreviewServer({ port: TEST_PORT }, { onModelKindChange: (kind) => received.push(kind) });
    await server.start();

    await sendAndWait(TEST_PORT, { type: 'hello', modelKind: 'cubism', protocolVersion: 1 });

    expect(received).toEqual(['cubism']);
    await server.stop();
  });

  // -------------------------------------------------------------------------
  // Test b — valid hello 'vrm' dispatched to handler
  // -------------------------------------------------------------------------
  test('valid hello with modelKind=vrm calls onModelKindChange', async () => {
    const received: (ModelKind | null)[] = [];
    const server = new PreviewServer({ port: TEST_PORT + 1 }, { onModelKindChange: (kind) => received.push(kind) });
    await server.start();

    await sendAndWait(TEST_PORT + 1, { type: 'hello', modelKind: 'vrm', protocolVersion: 1 });

    expect(received).toEqual(['vrm']);
    await server.stop();
  });

  // -------------------------------------------------------------------------
  // Test c — valid hello with modelKind=null dispatched to handler
  // -------------------------------------------------------------------------
  test('valid hello with modelKind=null calls onModelKindChange with null', async () => {
    const received: (ModelKind | null)[] = [];
    const server = new PreviewServer({ port: TEST_PORT + 2 }, { onModelKindChange: (kind) => received.push(kind) });
    await server.start();

    await sendAndWait(TEST_PORT + 2, { type: 'hello', modelKind: null, protocolVersion: 1 });

    expect(received).toEqual([null]);
    await server.stop();
  });

  // -------------------------------------------------------------------------
  // Test d — invalid modelKind is warned and dropped; handler not called
  // -------------------------------------------------------------------------
  test('hello with invalid modelKind warns and does not call handler', async () => {
    const received: (ModelKind | null)[] = [];
    const server = new PreviewServer({ port: TEST_PORT + 3 }, { onModelKindChange: (kind) => received.push(kind) });
    await server.start();

    // Send a hello with an unrecognized modelKind value
    await sendAndWait(TEST_PORT + 3, { type: 'hello', modelKind: 'unknown-format', protocolVersion: 1 });

    // Handler must not have been called
    expect(received).toEqual([]);
    await server.stop();
  });

  // -------------------------------------------------------------------------
  // Test e — no crash and no handler call when onModelKindChange is absent
  // -------------------------------------------------------------------------
  test('hello with no handler registered does not throw', async () => {
    // No onModelKindChange registered — server must not crash.
    const server = new PreviewServer({ port: TEST_PORT + 4 }, {});
    await server.start();

    await expect(
      sendAndWait(TEST_PORT + 4, { type: 'hello', modelKind: 'vrm', protocolVersion: 1 }),
    ).resolves.toBeUndefined();

    await server.stop();
  });
});
