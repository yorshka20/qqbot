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
   * Next queue[0] synthesis started early so it can overlap decode/broadcast
   * of the previous utterance and wall-clock playback (we no longer block the
   * pump until audio finishes on the client).
   */
  private prefetch: { text: string; promise: Promise<SynthesisResult> } | null = null;

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
        this.prefetch = null;
        break;
      }

      const utterance = this.queue[0];
      const utteranceId = crypto.randomUUID();
      logger.info(
        `[SpeechService] synthesize start — id=${utteranceId} provider="${this.provider.name}" len=${utterance.length}`,
      );

      let result: SynthesisResult;
      try {
        if (this.prefetch && this.prefetch.text === utterance) {
          const saved = this.prefetch;
          this.prefetch = null;
          try {
            result = await saved.promise;
          } catch {
            result = await this.provider.synthesize(utterance);
          }
        } else {
          result = await this.provider.synthesize(utterance);
        }
      } catch (err) {
        this.queue.shift();
        this.prefetch = null;
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

      if (this.queue.length > 0) {
        const next = this.queue[0];
        if (next) {
          this.prefetch = { text: next, promise: this.provider.synthesize(next) };
        }
      } else {
        this.prefetch = null;
      }
    }

    this.draining = false;
    this.prefetch = null;
  }
}
