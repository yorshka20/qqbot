import { decodeToMonoPcm } from './compiler/audio/decodeToMonoPcm';
import { computeRmsEnvelope } from './compiler/audio/rms';
import { type AnimationLayer, AudioEnvelopeLayer } from './compiler/layers';
import type { AudioMessage } from './preview/types';
import { splitIntoUtterances } from './tts/splitIntoUtterances';
import type { TTSProvider } from './tts/TTSProvider';

const DEFAULT_GAP_MS = 200;
/** RMS hop matches the one applied inside AudioEnvelopeLayer; keep them in sync. */
const ENVELOPE_HOP_MS = 20;
/** Extra ms after the utterance end before we unregister the layer — safety
 *  margin so the layer's `sample()` boundary check isn't racing with
 *  clock drift. `AudioEnvelopeLayer.sample` already returns `{}` past the end,
 *  so this timeout is purely for registry hygiene. */
const LAYER_UNREGISTER_SAFETY_MS = 500;

export class SpeechService {
  private queue: string[] = [];
  private draining = false;
  private lastEndTime = 0;

  constructor(
    private provider: TTSProvider,
    private broadcastAudio: (msg: AudioMessage) => void,
    private hasConsumer: () => boolean,
    private registerLayer: (layer: AnimationLayer) => void,
    private unregisterLayer: (id: string) => void,
    private clock: () => number = Date.now,
    private gapMs: number = DEFAULT_GAP_MS,
  ) {}

  speak(text: string, opts?: { maxCharsPerUtterance?: number }): void {
    if (!this.hasConsumer()) return;
    const utterances = splitIntoUtterances(text, opts?.maxCharsPerUtterance);
    this.queue.push(...utterances);
    if (!this.draining) {
      this.draining = true;
      this.drain();
    }
  }

  isSpeaking(): boolean {
    return this.draining;
  }
  getQueueLength(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      if (!this.hasConsumer()) {
        this.queue = [];
        break;
      }

      const utterance = this.queue.shift()!;
      const utteranceId = crypto.randomUUID();

      let bytes: Uint8Array;
      let mime: string;
      let estimatedDurationMs: number;

      try {
        const result = await this.provider.synthesize(utterance);
        bytes = result.bytes;
        mime = result.mime;
        estimatedDurationMs = result.durationMs;
      } catch (err) {
        console.warn('[SpeechService] synthesize failed, skipping utterance:', err);
        continue;
      }

      // Decode + compute envelope. Non-fatal: if anything throws, we still
      // ship the audio but skip lip-sync for this utterance.
      let envelope: Float32Array | null = null;
      let accurateDurationMs = estimatedDurationMs;
      try {
        const decoded = await decodeToMonoPcm(bytes, mime);
        envelope = computeRmsEnvelope(decoded.pcm, decoded.sampleRate, { hopMs: ENVELOPE_HOP_MS });
        accurateDurationMs = (decoded.pcm.length / decoded.sampleRate) * 1000;
      } catch (err) {
        console.warn('[SpeechService] failed to decode audio for lip-sync; broadcasting audio without envelope:', err);
      }

      const now = this.clock();
      const startAtEpochMs = Math.max(now, this.lastEndTime + this.gapMs);
      this.lastEndTime = startAtEpochMs + accurateDurationMs;

      const layerId = `audio-envelope-${utteranceId}`;
      if (envelope) {
        const layer = new AudioEnvelopeLayer({
          id: layerId,
          envelope,
          hopMs: ENVELOPE_HOP_MS,
          startAtMs: startAtEpochMs,
          durationMs: accurateDurationMs,
        });
        this.registerLayer(layer);
        setTimeout(() => {
          this.unregisterLayer(layerId);
        }, accurateDurationMs + LAYER_UNREGISTER_SAFETY_MS);
      }

      this.broadcastAudio({
        type: 'audio',
        data: {
          base64: Buffer.from(bytes).toString('base64'),
          mime,
          startAtEpochMs,
          durationMs: accurateDurationMs,
          utteranceId,
        },
      });

      const waitMs = this.lastEndTime - this.clock();
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
    }

    this.draining = false;
  }
}
