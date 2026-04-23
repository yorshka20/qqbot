import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AvatarService } from '../AvatarService';
import type { RendererCapabilities } from '../preview/types';

// ---------------------------------------------------------------------------
// Shared capability fixture
// ---------------------------------------------------------------------------

function makeCaps(slug: string, overrides?: Partial<RendererCapabilities>): RendererCapabilities {
  return {
    expressions: ['happy', 'sad'],
    supportedChannels: ['head.x', 'body.z'],
    customExpressions: ['mouth_grin'],
    modelId: { kind: 'vrm', slug },
    ...overrides,
  };
}

/** Minimal WebSocket stand-in — only needs identity (reference equality). */
function makeMockWs(remoteAddress?: string): WebSocket {
  return { remoteAddress } as unknown as WebSocket;
}

// ---------------------------------------------------------------------------
// Helper: get the PreviewServer handlers via a narrow cast.
// AvatarService wires handlers at initialize() time; accessing them here lets
// us invoke the callbacks synchronously without spinning a real WS server.
// ---------------------------------------------------------------------------
type HandlerSlice = {
  onCapabilities?: (caps: RendererCapabilities, ws: WebSocket) => void;
  onConnectionClosed?: (ws: WebSocket) => void;
  getConnectedCapabilities?: () => Array<{ remoteAddr: string; caps: RendererCapabilities; receivedAt: string }>;
};

function getHandlers(service: AvatarService): HandlerSlice {
  const inner = service as unknown as {
    previewServer: { handlers: HandlerSlice } | null;
  };
  if (!inner.previewServer) throw new Error('previewServer not initialized');
  return inner.previewServer.handlers;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('AvatarService capability store', () => {
  let service: AvatarService;

  beforeEach(async () => {
    service = new AvatarService();
    await service.initialize({
      enabled: true,
      vts: { enabled: false },
      preview: { enabled: true, host: '127.0.0.1', port: 0 },
      speech: { enabled: false },
      compiler: { fps: 60, outputFps: 60 },
    });
  });

  afterEach(async () => {
    await service.stop();
  });

  // -------------------------------------------------------------------------
  // Test a — onCapabilities inserts entry; listConnectedCapabilities returns it
  // -------------------------------------------------------------------------
  test('onCapabilities stores entry and listConnectedCapabilities returns it with ISO timestamp', () => {
    const handlers = getHandlers(service);
    const caps = makeCaps('my-model');
    const ws = makeMockWs('10.0.0.1:9000');

    const before = Date.now();
    handlers.onCapabilities!(caps, ws);
    const after = Date.now();

    const list = service.listConnectedCapabilities();
    expect(list).toHaveLength(1);
    expect(list[0].caps).toEqual(caps);
    expect(list[0].remoteAddr).toBe('10.0.0.1:9000');

    // ISO string must parse back to a timestamp within the test window
    const ts = new Date(list[0].receivedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  // -------------------------------------------------------------------------
  // Test b — onConnectionClosed removes the entry
  // -------------------------------------------------------------------------
  test('onConnectionClosed removes the entry', () => {
    const handlers = getHandlers(service);
    const ws = makeMockWs();

    handlers.onCapabilities!(makeCaps('avatar'), ws);
    expect(service.listConnectedCapabilities()).toHaveLength(1);

    handlers.onConnectionClosed!(ws);
    expect(service.listConnectedCapabilities()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test c — two distinct sockets create two distinct entries, order-independent
  // -------------------------------------------------------------------------
  test('two distinct mock sockets create two distinct entries', () => {
    const handlers = getHandlers(service);
    const ws1 = makeMockWs('10.0.0.1:1111');
    const ws2 = makeMockWs('10.0.0.2:2222');

    handlers.onCapabilities!(makeCaps('model-a'), ws1);
    handlers.onCapabilities!(makeCaps('model-b'), ws2);

    const list = service.listConnectedCapabilities();
    expect(list).toHaveLength(2);

    const slugs = list.map((e) => e.caps.modelId.slug).sort();
    expect(slugs).toEqual(['model-a', 'model-b']);
  });

  // -------------------------------------------------------------------------
  // Test d — returned objects are JSON-safe (no Date, no raw socket references)
  // -------------------------------------------------------------------------
  test('returned objects are JSON-safe', () => {
    const handlers = getHandlers(service);
    handlers.onCapabilities!(makeCaps('safe-model'), makeMockWs());

    const list = service.listConnectedCapabilities();
    expect(list).toHaveLength(1);

    // Must round-trip through JSON without throwing or losing data
    const roundTripped = JSON.parse(JSON.stringify(list)) as typeof list;
    expect(roundTripped[0].caps.modelId.slug).toBe('safe-model');
    expect(typeof roundTripped[0].receivedAt).toBe('string');
    expect(typeof roundTripped[0].remoteAddr).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Test e — socket without remoteAddress falls back to 'unknown'
  // -------------------------------------------------------------------------
  test('socket without remoteAddress falls back to "unknown"', () => {
    const handlers = getHandlers(service);
    const ws = makeMockWs(); // no remoteAddress

    handlers.onCapabilities!(makeCaps('no-addr'), ws);
    const list = service.listConnectedCapabilities();
    expect(list[0].remoteAddr).toBe('unknown');
  });

  // -------------------------------------------------------------------------
  // Test f — getConnectedCapabilities delegate returns same data as
  //           listConnectedCapabilities()
  // -------------------------------------------------------------------------
  test('getConnectedCapabilities delegate matches listConnectedCapabilities()', () => {
    const handlers = getHandlers(service);
    handlers.onCapabilities!(makeCaps('delegate-model'), makeMockWs('1.2.3.4:5678'));

    const viaPublic = service.listConnectedCapabilities();
    const viaHandler = handlers.getConnectedCapabilities!();
    expect(viaHandler).toEqual(viaPublic);
  });

  // -------------------------------------------------------------------------
  // Test g — removing one of two entries leaves the other intact
  // -------------------------------------------------------------------------
  test('removing one of two entries leaves the other intact', () => {
    const handlers = getHandlers(service);
    const ws1 = makeMockWs();
    const ws2 = makeMockWs();

    handlers.onCapabilities!(makeCaps('keep-me'), ws1);
    handlers.onCapabilities!(makeCaps('remove-me'), ws2);

    handlers.onConnectionClosed!(ws2);

    const list = service.listConnectedCapabilities();
    expect(list).toHaveLength(1);
    expect(list[0].caps.modelId.slug).toBe('keep-me');
  });
});
