import 'reflect-metadata';

import { describe, expect, test } from 'bun:test';
import { SpeechService } from './SpeechService';
import type { SynthesisResult, TTSProvider } from './tts/TTSProvider';

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
