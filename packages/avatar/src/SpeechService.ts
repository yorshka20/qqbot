import { decodeToMonoPcm } from './compiler/audio/decodeToMonoPcm';
import { computeRmsEnvelope } from './compiler/audio/rms';
import { type AnimationLayer, AudioEnvelopeLayer } from './compiler/layers';
import type { AudioMessage } from './preview/types';
import { splitIntoUtterances } from './tts/splitIntoUtterances';
import type { SynthesisResult, TTSProvider } from './tts/TTSProvider';
import { logger } from './utils/logger';
import { fromRepoRoot } from './utils/repoRoot';
import { writeFileUnderDirectory } from './utils/writeFileUnderDirectory';

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
  /**
   * Synthesis promise for `queue[1]` fired in parallel with `queue[0]`'s
   * synth/decode/broadcast. One-deep pipeline — by the time we finish
   * broadcasting queue[0], queue[1]'s audio is usually already back from
   * the provider, so the gap between utterances shrinks to decode+broadcast
   * time instead of a full network+inference round-trip.
   */
  private inflightNext: { text: string; promise: Promise<SynthesisResult> } | null = null;

  constructor(
    private provider: TTSProvider,
    private broadcastAudio: (msg: AudioMessage) => void,
    private hasConsumer: () => boolean,
    private registerLayer: (layer: AnimationLayer) => void,
    private unregisterLayer: (id: string) => void,
    private clock: () => number = Date.now,
    private gapMs: number = DEFAULT_GAP_MS,
    private exportTtsWavDir?: string,
  ) {}

  /**
   * Kick off synthesis for `queue[1]` if not already in flight. Called twice
   * per drain iteration: once at the top so it runs in parallel with the
   * current utterance's synth+decode+broadcast, once after the queue shift
   * to catch any utterance enqueued mid-iteration.
   */
  private primeNext(): void {
    if (this.inflightNext) return;
    if (this.queue.length < 2) return;
    const peek = this.queue[1];
    const promise = this.provider.synthesize(peek);
    // Attach a no-op catch so an early rejection isn't surfaced as an
    // unhandled rejection before we reach the `await` site. The real `await`
    // in `drain()` still observes the error.
    promise.catch(() => {});
    this.inflightNext = { text: peek, promise };
  }

  speak(text: string, opts?: { maxCharsPerUtterance?: number }): void {
    const consumer = this.hasConsumer();
    logger.info(
      `[SpeechService] speak() called — textLen=${text.length} consumer=${consumer} queueLen=${this.queue.length} draining=${this.draining}`,
    );
    if (!consumer) {
      logger.info('[SpeechService] skipped: no frame consumer connected (renderer not open?)');
      return;
    }
    const utterances = splitIntoUtterances(text, opts?.maxCharsPerUtterance);
    logger.info(`[SpeechService] split into ${utterances.length} utterance(s)`);
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
        logger.info(`[SpeechService] consumer left mid-queue; dropping ${this.queue.length} pending utterance(s)`);
        this.queue = [];
        this.inflightNext = null;
        break;
      }

      const utterance = this.queue[0];
      const utteranceId = crypto.randomUUID();
      logger.info(
        `[SpeechService] synthesize start — id=${utteranceId} provider="${this.provider.name}" len=${utterance.length}`,
      );

      // Start or reuse synthesis for the head utterance.
      let headPromise: Promise<SynthesisResult>;
      if (this.inflightNext && this.inflightNext.text === utterance) {
        headPromise = this.inflightNext.promise;
        this.inflightNext = null;
      } else {
        headPromise = this.provider.synthesize(utterance);
      }

      // Fire queue[1] synthesis NOW so it runs concurrently with queue[0]'s
      // await + decode + broadcast. This is the key change vs. the old
      // "prefetch after broadcast" behavior.
      this.primeNext();

      let result: SynthesisResult;
      try {
        result = await headPromise;
      } catch (err) {
        this.queue.shift();
        logger.warn(
          `[SpeechService] synthesize failed — id=${utteranceId} err=${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      this.queue.shift();

      const bytes = result.bytes;
      const mime = result.mime;
      const estimatedDurationMs = result.durationMs;
      logger.info(
        `[SpeechService] synthesize ok — id=${utteranceId} bytes=${bytes.length} mime=${mime} est=${Math.round(estimatedDurationMs)}ms`,
      );
      if (this.exportTtsWavDir) {
        try {
          const ext = mime.includes('mpeg') || mime.includes('mp3') || mime.includes('MPEG') ? 'mp3' : 'wav';
          const fname = `${Date.now()}-${utteranceId.slice(0, 8)}.${ext}`;
          const p = writeFileUnderDirectory(fromRepoRoot(this.exportTtsWavDir), fname, bytes);
          logger.info(`[SpeechService] wrote TTS file — ${p}`);
        } catch (err) {
          logger.warn(
            `[SpeechService] export TTS to disk failed — id=${utteranceId} err=${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Decode + compute envelope. Non-fatal: if anything throws, we still
      // ship the audio but skip lip-sync for this utterance.
      let envelope: Float32Array | null = null;
      let accurateDurationMs = estimatedDurationMs;
      try {
        const decoded = await decodeToMonoPcm(bytes, mime);
        envelope = computeRmsEnvelope(decoded.pcm, decoded.sampleRate, { hopMs: ENVELOPE_HOP_MS });
        accurateDurationMs = (decoded.pcm.length / decoded.sampleRate) * 1000;
        logger.debug(
          `[SpeechService] decode+rms ok — id=${utteranceId} pcmSamples=${decoded.pcm.length} sr=${decoded.sampleRate} envFrames=${envelope.length} dur=${Math.round(accurateDurationMs)}ms`,
        );
      } catch (err) {
        logger.warn(
          `[SpeechService] decode/envelope failed (lip-sync skipped, still broadcasting audio) — id=${utteranceId} err=${err instanceof Error ? err.message : String(err)}`,
        );
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
          text: utterance,
        },
      });
      logger.info(
        `[SpeechService] broadcast audio — id=${utteranceId} startAt=${startAtEpochMs} dur=${Math.round(accurateDurationMs)}ms lipSync=${envelope !== null}`,
      );

      // Re-check in case new utterances were enqueued during decode/broadcast:
      // queue[0] (the new head) may not have a prefetch yet.
      this.primeNext();
    }

    this.draining = false;
    this.inflightNext = null;
  }
}
