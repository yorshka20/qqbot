/**
 * PreviewServer broadcastAudioChunk tests.
 *
 * Verifies that `broadcastAudioChunk` sends an `audio-chunk` message to all
 * connected WebSocket clients, mirroring the semantics of `broadcastAudio`.
 *
 * Uses real Bun WS connections to the real server — no mocks.
 */
import { describe, expect, test } from 'bun:test';
import { PreviewServer } from './PreviewServer';
import type { AudioChunkMessage } from './types';

// Use a high port range to avoid conflicts with other test files.
const TEST_PORT = 48900;

/** Connect a WS, collect messages for `collectMs`, then close and return them. */
async function collectMessages(port: number, collectMs = 120): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const messages: string[] = [];
    const ws = new WebSocket(`ws://localhost:${port}/`);
    ws.onopen = () => {
      setTimeout(() => {
        ws.close();
        resolve(messages);
      }, collectMs);
    };
    ws.onmessage = (evt) => {
      messages.push(typeof evt.data === 'string' ? evt.data : String(evt.data));
    };
    ws.onerror = () => reject(new Error('WebSocket error'));
  });
}

describe('PreviewServer broadcastAudioChunk', () => {
  // -------------------------------------------------------------------------
  // Test a — data chunk is received by connected client
  // -------------------------------------------------------------------------
  test('data chunk is received by connected client with correct shape', async () => {
    const server = new PreviewServer({ port: TEST_PORT }, {});
    await server.start();

    // Give the WS time to connect, then broadcast, then collect.
    const collectPromise = collectMessages(TEST_PORT, 150);

    // Wait a tick for the client to open.
    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    const msg: AudioChunkMessage = {
      type: 'audio-chunk',
      data: {
        utteranceId: 'test-utterance-1',
        seq: 0,
        base64: 'AQID',
        isLast: false,
        mime: 'audio/pcm',
        sampleRate: 32000,
        startAtEpochMs: 1000000,
        text: 'hello',
      },
    };
    server.broadcastAudioChunk(msg);

    const received = await collectPromise;
    await server.stop();

    expect(received.length).toBeGreaterThanOrEqual(1);
    // Find the audio-chunk message (may include a cached status message first)
    const chunkMsg = received.find((raw) => {
      try {
        return (JSON.parse(raw) as { type?: string }).type === 'audio-chunk';
      } catch {
        return false;
      }
    });
    expect(chunkMsg).toBeDefined();
    if (!chunkMsg) throw new Error('no chunk message received');
    const parsed = JSON.parse(chunkMsg) as AudioChunkMessage;
    expect(parsed.type).toBe('audio-chunk');
    expect(parsed.data.utteranceId).toBe('test-utterance-1');
    expect(parsed.data.seq).toBe(0);
    expect(parsed.data.isLast).toBe(false);
    expect(parsed.data.mime).toBe('audio/pcm');
    expect(parsed.data.sampleRate).toBe(32000);
  });

  // -------------------------------------------------------------------------
  // Test b — terminator chunk (isLast=true, empty base64) is received
  // -------------------------------------------------------------------------
  test('terminator chunk (isLast=true, empty base64) is received by connected client', async () => {
    const server = new PreviewServer({ port: TEST_PORT + 1 }, {});
    await server.start();

    const collectPromise = collectMessages(TEST_PORT + 1, 150);
    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    const terminator: AudioChunkMessage = {
      type: 'audio-chunk',
      data: {
        utteranceId: 'test-utterance-2',
        seq: 3,
        base64: '',
        isLast: true,
        totalDurationMs: 1500,
      },
    };
    server.broadcastAudioChunk(terminator);

    const received = await collectPromise;
    await server.stop();

    const chunkMsg = received.find((raw) => {
      try {
        return (JSON.parse(raw) as { type?: string }).type === 'audio-chunk';
      } catch {
        return false;
      }
    });
    expect(chunkMsg).toBeDefined();
    if (!chunkMsg) throw new Error('no chunk message received');
    const parsed = JSON.parse(chunkMsg) as AudioChunkMessage;
    expect(parsed.data.isLast).toBe(true);
    expect(parsed.data.base64).toBe('');
    expect(parsed.data.totalDurationMs).toBe(1500);
  });
});
