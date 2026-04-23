import 'reflect-metadata';

import { describe, expect, test } from 'bun:test';
import type { AudioChunkMessage } from './preview/types';
import { SpeechService } from './SpeechService';
import type { SynthesisChunk, SynthesisResult, TTSProvider } from './tts/TTSProvider';

/**
 * Record the order in which the provider's `synthesize` is invoked. Each
 * call resolves after `delayMs` so we can simulate realistic synthesis
 * latency and parallel overlap.
 */
function makeRecordingProvider(delayMs = 10): {
  provider: TTSProvider;
  synthOrder: string[];
} {
  const synthOrder: string[] = [];
  const provider: TTSProvider = {
    name: 'mock',
    isAvailable: () => true,
    synthesize(text: string): Promise<SynthesisResult> {
      synthOrder.push(text);
      return new Promise((resolve) => {
        setTimeout(() => {
          // Tiny valid-looking WAV-ish bytes; SpeechService will fail decode
          // but broadcast still happens (non-fatal path).
          const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
          resolve({ bytes, mime: 'audio/wav', durationMs: 100 });
        }, delayMs);
      });
    },
  };
  return { provider, synthOrder };
}

/** Create a minimal valid s16le PCM Uint8Array with `frameCount` silence frames. */
function makePcmBytes(frameCount = 32): Uint8Array {
  // 16-bit = 2 bytes per frame, all zeros = silence
  return new Uint8Array(frameCount * 2);
}

/**
 * Provider that supports synthesizeStream and yields the given chunks with
 * a small inter-chunk delay to simulate network latency.
 */
function makeStreamingProvider(chunks: SynthesisChunk[]): TTSProvider {
  return {
    name: 'mock-stream',
    isAvailable: () => true,
    synthesize(): Promise<SynthesisResult> {
      // Should not be called when streaming path is active.
      return Promise.resolve({ bytes: new Uint8Array(0), mime: 'audio/pcm', durationMs: 0 });
    },
    async *synthesizeStream(): AsyncGenerator<SynthesisChunk> {
      for (const chunk of chunks) {
        await new Promise<void>((r) => setTimeout(r, 5));
        yield chunk;
      }
    },
  };
}

describe('SpeechService — synth ordering', () => {
  test('utterances enqueued during an in-flight head synth are synthesized in queue order', async () => {
    const { provider, synthOrder } = makeRecordingProvider(20);
    const broadcasts: string[] = [];
    const service = new SpeechService(
      provider,
      (msg) => {
        broadcasts.push(msg.data.text);
      },
      () => true,
      () => {},
      () => {},
    );

    // Reproduce the real-world scenario: the LLM streams 4 utterances in
    // rapid succession while the first one is still being synthesized.
    service.speak('哈？');
    // Let drain kick in (it's sync up to the first await inside synthesize).
    await Promise.resolve();
    service.speak('你创造的我？');
    service.speak('那麻烦这位造物主先把电费结一下好吗？');
    service.speak('少在这儿空手套白狼乱认亲戚。');

    // Wait for drain to complete.
    while (service.isSpeaking()) {
      await new Promise((r) => setTimeout(r, 30));
    }

    expect(synthOrder).toEqual([
      '哈？',
      '你创造的我？',
      '那麻烦这位造物主先把电费结一下好吗？',
      '少在这儿空手套白狼乱认亲戚。',
    ]);
    expect(broadcasts).toEqual(synthOrder);
  });

  test('single utterance — synth called exactly once', async () => {
    const { provider, synthOrder } = makeRecordingProvider(10);
    const service = new SpeechService(
      provider,
      () => {},
      () => true,
      () => {},
      () => {},
    );

    service.speak('只有一句话');
    while (service.isSpeaking()) {
      await new Promise((r) => setTimeout(r, 15));
    }

    expect(synthOrder).toEqual(['只有一句话']);
  });
});

describe('SpeechService — streaming path', () => {
  test('two-chunk streaming success: correct seq / metadata / isLast / totalDurationMs', async () => {
    // Two PCM chunks: chunk 0 (data), chunk 1 (terminator with isLast + totalDurationMs).
    const pcmBytes = makePcmBytes(32); // 32 samples = 1 ms at 32 kHz
    const chunks: SynthesisChunk[] = [
      {
        bytes: pcmBytes,
        mime: 'audio/pcm',
        sampleRate: 32000,
        isLast: false,
      },
      {
        bytes: makePcmBytes(32),
        mime: 'audio/pcm',
        sampleRate: 32000,
        isLast: true,
        totalDurationMs: 2,
      },
    ];

    const provider = makeStreamingProvider(chunks);
    const broadcastedChunks: AudioChunkMessage[] = [];
    const registeredLayerIds: string[] = [];

    const service = new SpeechService(
      provider,
      () => {}, // broadcastAudio — unused in streaming path
      () => true, // hasConsumer
      (layer) => {
        registeredLayerIds.push(layer.id);
      },
      () => {}, // unregisterLayer
      Date.now, // clock
      200, // gapMs
      undefined, // exportTtsWavDir
      (msg) => {
        broadcastedChunks.push(msg);
      },
    );

    service.speak('hello streaming');
    while (service.isSpeaking()) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Exactly two chunks broadcast.
    expect(broadcastedChunks.length).toBe(2);

    // seq 0 carries full metadata.
    const c0 = broadcastedChunks[0].data;
    expect(c0.seq).toBe(0);
    expect(c0.isLast).toBe(false);
    expect(c0.mime).toBe('audio/pcm');
    expect(c0.sampleRate).toBe(32000);
    expect(typeof c0.startAtEpochMs).toBe('number');
    expect(c0.text).toBe('hello streaming');

    // seq 1 is the final chunk.
    const c1 = broadcastedChunks[1].data;
    expect(c1.seq).toBe(1);
    expect(c1.isLast).toBe(true);
    expect(c1.totalDurationMs).toBe(2);
    // Later chunks must NOT carry seq-0-only fields.
    expect(c1.mime).toBeUndefined();
    expect(c1.text).toBeUndefined();
    expect(c1.startAtEpochMs).toBeUndefined();

    // Both chunks share the same stable utteranceId.
    expect(typeof c0.utteranceId).toBe('string');
    expect(c0.utteranceId).toBe(c1.utteranceId);

    // Layer was registered during streaming.
    expect(registeredLayerIds.length).toBe(1);
  });

  test('consumer leaves mid-stream: no further chunks broadcast; layer unregistered', async () => {
    // Three chunks, but consumer disconnects after seq 0 is broadcast.
    const pcmBytes = makePcmBytes(32);
    const chunks: SynthesisChunk[] = [
      { bytes: pcmBytes, mime: 'audio/pcm', sampleRate: 32000, isLast: false },
      { bytes: pcmBytes, mime: 'audio/pcm', sampleRate: 32000, isLast: false },
      {
        bytes: new Uint8Array(0),
        mime: 'audio/pcm',
        sampleRate: 32000,
        isLast: true,
        totalDurationMs: 10,
      },
    ];

    const provider = makeStreamingProvider(chunks);
    const broadcastedChunks: AudioChunkMessage[] = [];
    const unregisteredLayerIds: string[] = [];
    let consumerConnected = true;

    const service = new SpeechService(
      provider,
      () => {},
      () => consumerConnected,
      () => {},
      (id) => {
        unregisteredLayerIds.push(id);
      },
      Date.now,
      200,
      undefined,
      (msg) => {
        broadcastedChunks.push(msg);
        // Disconnect after seq 0 is received.
        if (broadcastedChunks.length >= 1) {
          consumerConnected = false;
        }
      },
    );

    service.speak('consumer leaves');
    while (service.isSpeaking()) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Only the first chunk (seq 0) was broadcast before disconnect.
    expect(broadcastedChunks.length).toBe(1);
    expect(broadcastedChunks[0].data.seq).toBe(0);

    // Layer must be unregistered (not leaked) after consumer leaves.
    expect(unregisteredLayerIds.length).toBeGreaterThanOrEqual(1);
  });

  test('provider without synthesizeStream uses legacy broadcastAudio path', async () => {
    // makeRecordingProvider returns a provider with no synthesizeStream method.
    const { provider, synthOrder } = makeRecordingProvider(10);
    const bufferedBroadcasts: string[] = [];
    const chunkBroadcasts: AudioChunkMessage[] = [];

    const service = new SpeechService(
      provider,
      (msg) => {
        bufferedBroadcasts.push(msg.data.text);
      },
      () => true,
      () => {},
      () => {},
      Date.now,
      200,
      undefined,
      (msg) => {
        chunkBroadcasts.push(msg);
      },
    );

    service.speak('buffered only');
    while (service.isSpeaking()) {
      await new Promise((r) => setTimeout(r, 15));
    }

    // Legacy path used: synthesize() called, broadcastAudio fires, no chunks.
    expect(synthOrder).toEqual(['buffered only']);
    expect(bufferedBroadcasts).toEqual(['buffered only']);
    expect(chunkBroadcasts.length).toBe(0);
  });
});
