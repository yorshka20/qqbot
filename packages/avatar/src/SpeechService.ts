import { decodeToMonoPcm } from './compiler/audio/decodeToMonoPcm';
import { computeRmsEnvelope } from './compiler/audio/rms';
import { RmsStreamer } from './compiler/audio/rmsStreaming';
import { type AnimationLayer, AudioEnvelopeLayer } from './compiler/layers';
import type { AudioChunkMessage, AudioMessage } from './preview/types';
import { splitIntoUtterances } from './tts/splitIntoUtterances';
import type { SynthesisChunk, SynthesisResult, TTSProvider } from './tts/TTSProvider';
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
/** Generous placeholder durationMs for a streaming AudioEnvelopeLayer before
 *  finalize() is called. AudioEnvelopeLayer.sample() returns {} when the
 *  playhead is past this duration, so it must be large enough that real
 *  audio never exceeds it. finalize() overwrites it with the actual value. */
const STREAMING_PLACEHOLDER_DURATION_MS = 60_000;

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
   *
   * Used only in the buffered path; the streaming path does not pre-synthesize.
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
    /**
     * Optional callback for streaming PCM utterances. When provided AND the
     * active provider exposes `synthesizeStream`, `drain()` uses the streaming
     * path and calls this callback per chunk instead of `broadcastAudio`.
     * Callers that omit this parameter continue to use the legacy buffered path.
     */
    private broadcastAudioChunk?: (msg: AudioChunkMessage) => void,
  ) {}

  /**
   * Kick off synthesis for the utterance at `queue[index]` if nothing is
   * already in flight. Called with different indices depending on where
   * in the drain loop we are:
   *
   * - **Before shift** (iter top, `queue[0]` is the CURRENT head being
   *   awaited): pass `1` — prime one ahead so the NEXT iteration can reuse.
   * - **After shift** (iter bottom, `queue[0]` is the NEXT head because
   *   the current head was just shifted out): pass `0` — prime the new head
   *   directly.
   *
   * Passing the wrong index causes Sovits to receive synthesis requests
   * out of sequence order, which manifests as dropped utterances on the
   * renderer (single-track preemption: whichever chunk arrives last wins).
   */
  private primeNext(index: number): void {
    if (this.inflightNext) return;
    if (this.queue.length <= index) return;
    const peek = this.queue[index];
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
      const canStream = this.broadcastAudioChunk !== undefined && typeof this.provider.synthesizeStream === 'function';

      if (canStream) {
        // Streaming path — inflightNext optimization does not apply.
        // Clear any stale pre-synthesis promise so it doesn't confuse a future
        // buffered iteration if we ever switch back.
        this.inflightNext = null;
        await this.drainOneStreaming(utterance);
        // queue.shift() is handled inside drainOneStreaming (or its buffered fallback)
      } else {
        // Buffered path — preserves original behaviour bit-for-bit.
        await this.drainOneBuffered(utterance);
        // Post-shift: queue[0] is the NEW head. Prime it so the next iteration
        // can reuse the promise and save a full synthesis round-trip.
        this.primeNext(0);
      }
    }

    this.draining = false;
    this.inflightNext = null;
  }

  /**
   * Buffered path: await full synthesis → decode → register AudioEnvelopeLayer
   * → broadcast AudioMessage. Preserves the original behaviour bit-for-bit,
   * including the one-deep `inflightNext` prefetch optimisation.
   */
  private async drainOneBuffered(utterance: string): Promise<void> {
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
    // await + decode + broadcast. Pre-shift: queue[0] is the current head,
    // queue[1] is the NEXT iteration's head — that's what we want to prime.
    this.primeNext(1);

    let result: SynthesisResult;
    try {
      result = await headPromise;
    } catch (err) {
      this.queue.shift();
      logger.warn(
        `[SpeechService] synthesize failed — id=${utteranceId} err=${err instanceof Error ? err.message : String(err)}`,
      );
      return;
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
  }

  /**
   * Streaming path: consume `provider.synthesizeStream(utterance)` chunk-by-chunk.
   *
   * On seq 0: allocate utteranceId, compute startAtEpochMs, register a streaming
   * AudioEnvelopeLayer with a generous placeholder duration. For each non-empty
   * PCM chunk: decode via decodeToMonoPcm, feed RmsStreamer, append frames.
   * Broadcast AudioChunkMessage immediately per chunk (zero-lag contract).
   *
   * Fallback to buffered path if:
   *   - synthesizeStream() throws synchronously, OR
   *   - The async iterator throws before emitting any chunk (seq === 0).
   *
   * Consumer disconnect: if hasConsumer() returns false mid-stream, stop
   * broadcasting, unregister the layer, and clear the queue entry.
   *
   * Mid-stream errors (seq > 0): unregister the layer and continue queue
   * processing (same semantics as buffered error handling).
   */
  private async drainOneStreaming(utterance: string): Promise<void> {
    const utteranceId = crypto.randomUUID();
    logger.info(
      `[SpeechService] synthesize start (streaming) — id=${utteranceId} provider="${this.provider.name}" len=${utterance.length}`,
    );

    // drain() only calls us when canStream is true (broadcastAudioChunk defined +
    // synthesizeStream present). Capture both as local non-nullable references.
    const broadcastChunk = this.broadcastAudioChunk;
    const synthesizeStream = this.provider.synthesizeStream;
    if (!broadcastChunk || !synthesizeStream) {
      await this.drainOneBuffered(utterance);
      return;
    }

    // Attempt to get the stream. Synchronous throws mean the provider doesn't
    // support streaming in its current config — fall back to buffered.
    let stream: AsyncIterable<SynthesisChunk>;
    try {
      stream = synthesizeStream.call(this.provider, utterance);
    } catch (err) {
      logger.warn(
        `[SpeechService] synthesizeStream threw synchronously, falling back to buffered — id=${utteranceId} err=${err instanceof Error ? err.message : String(err)}`,
      );
      await this.drainOneBuffered(utterance);
      return;
    }

    // Timing / layer state is lazily bound on the FIRST chunk. Rationale:
    // `synthesizeStream` returns an AsyncIterable but does not fire the HTTP
    // request until the first `for await` iteration — so the round-trip from
    // request-issued to first-chunk-received can be 300–800ms on a GPU
    // Sovits backend. If we captured `startAtEpochMs` here (before the
    // iteration starts), `layer.startAtMs` would be anchored to a wall-clock
    // that is already 500ms in the past by the time the renderer actually
    // starts playing audio.
    //
    // Consequence observed in prod: `sample(nowMs)` computes
    // `t = nowMs - startAtMs` which races ~500ms ahead of the real audio
    // playhead. The envelope writer (appendFrames) only catches up to the
    // real audio rate, so the sampling index permanently overshoots
    // `envelopeLength` → `sample()` returns `{}` → mouth never moves.
    //
    // Fix: defer `startAtEpochMs` and layer creation until we've actually
    // received chunk seq=0. That timestamp is a tight upper bound on when
    // the renderer receives + starts playing the same chunk (only WS latency
    // separates them, typically <20ms LAN), so the envelope clock and the
    // audio clock stay in lock-step.
    const layerId = `audio-envelope-${utteranceId}`;
    let startAtEpochMs = 0;
    let layer: AudioEnvelopeLayer | null = null;

    const rmsStreamer = new RmsStreamer({ hopMs: ENVELOPE_HOP_MS });
    let seq = 0;
    let totalPcmSamples = 0;
    let resolvedSampleRate = 0;
    let resolvedMime = '';
    let layerFinalized = false;

    try {
      for await (const chunk of stream) {
        // Consumer disconnect: stop mid-stream, unregister layer, drop utterance.
        if (!this.hasConsumer()) {
          logger.info(`[SpeechService] consumer left mid-stream — id=${utteranceId} seq=${seq}, stopping broadcast`);
          if (layer && !layerFinalized) {
            this.unregisterLayer(layerId);
            layerFinalized = true;
          }
          this.queue.shift();
          return;
        }

        if (seq === 0) {
          resolvedMime = chunk.mime;
          resolvedSampleRate = chunk.sampleRate ?? 32000;

          // Anchor the timing NOW — first chunk has arrived, renderer is
          // about to start playback. durationMs is a generous placeholder;
          // finalize() will set the real value when the stream ends.
          const now = this.clock();
          startAtEpochMs = Math.max(now, this.lastEndTime + this.gapMs);
          layer = new AudioEnvelopeLayer({
            id: layerId,
            hopMs: ENVELOPE_HOP_MS,
            startAtMs: startAtEpochMs,
            durationMs: STREAMING_PLACEHOLDER_DURATION_MS,
          });
          this.registerLayer(layer);
        }

        // After the seq===0 block `layer` is always set (seq===0 runs on the
        // first iteration and always assigns). The guard is dead code at
        // runtime but narrows the type for TS without a non-null assertion.
        if (!layer) continue;

        let chunkBase64 = '';

        if (chunk.bytes.length > 0) {
          chunkBase64 = Buffer.from(chunk.bytes).toString('base64');

          // RMS computation: only supported for audio/pcm (raw samples without
          // a container header). WAV/MP3 chunks cannot be decoded incrementally
          // because the header is only present in the first chunk.
          if (resolvedMime === 'audio/pcm' && resolvedSampleRate > 0) {
            try {
              const decoded = await decodeToMonoPcm(chunk.bytes, resolvedMime, {
                sampleRate: resolvedSampleRate,
              });
              totalPcmSamples += decoded.pcm.length;
              const frames = rmsStreamer.push(decoded.pcm, decoded.sampleRate);
              if (frames.length > 0) {
                layer.appendFrames(frames);
              }
            } catch (decodeErr) {
              logger.warn(
                `[SpeechService] chunk decode failed (lip-sync skipped for chunk) — id=${utteranceId} seq=${seq} err=${decodeErr instanceof Error ? decodeErr.message : String(decodeErr)}`,
              );
            }
          }
        }

        const isLast = chunk.isLast;
        let totalDurationMs: number | undefined;

        if (isLast) {
          // Prefer provider-reported duration; fall back to sample count.
          if (chunk.totalDurationMs !== undefined) {
            totalDurationMs = chunk.totalDurationMs;
          } else if (resolvedSampleRate > 0 && totalPcmSamples > 0) {
            totalDurationMs = (totalPcmSamples / resolvedSampleRate) * 1000;
          }

          // Flush any residual PCM that didn't fill a complete hop.
          const flushFrames = rmsStreamer.flush();
          if (flushFrames.length > 0) {
            layer.appendFrames(flushFrames);
          }

          const finalDurationMs = totalDurationMs ?? STREAMING_PLACEHOLDER_DURATION_MS;
          layer.finalize(finalDurationMs);
          layerFinalized = true;
          this.lastEndTime = startAtEpochMs + finalDurationMs;
          setTimeout(() => {
            this.unregisterLayer(layerId);
          }, finalDurationMs + LAYER_UNREGISTER_SAFETY_MS);

          logger.info(
            `[SpeechService] stream complete — id=${utteranceId} dur=${Math.round(finalDurationMs)}ms chunks=${seq + 1}`,
          );
        }

        // Broadcast immediately — zero-lag contract: no batching, no delay.
        broadcastChunk({
          type: 'audio-chunk',
          data: {
            utteranceId,
            seq,
            base64: chunkBase64,
            isLast,
            ...(totalDurationMs !== undefined ? { totalDurationMs } : {}),
            ...(seq === 0
              ? {
                  mime: resolvedMime,
                  sampleRate: resolvedSampleRate,
                  startAtEpochMs,
                  text: utterance,
                }
              : {}),
          },
        });

        logger.debug(
          `[SpeechService] broadcast chunk — id=${utteranceId} seq=${seq} bytes=${chunk.bytes.length} isLast=${isLast}`,
        );
        seq++;
      }
    } catch (err) {
      if (seq === 0) {
        // No chunks emitted yet — fall back to buffered synthesis so the
        // utterance is not silently lost. The layer is created lazily on
        // seq=0, so there's nothing to unregister here (either we never
        // registered it, or the error happened after registration within
        // the same iteration — in which case `layer !== null` below would
        // still catch it; but seq===0 branch means iteration aborted before
        // the increment, so the layer, if created, must be removed).
        logger.warn(
          `[SpeechService] synthesizeStream failed before first chunk, falling back to buffered — id=${utteranceId} err=${err instanceof Error ? err.message : String(err)}`,
        );
        if (layer && !layerFinalized) {
          this.unregisterLayer(layerId);
        }
        // drainOneBuffered handles queue.shift() internally.
        await this.drainOneBuffered(utterance);
        return;
      }
      // Mid-stream error (seq > 0): can't fall back — clean up layer and
      // continue queue processing (consistent with buffered error semantics).
      logger.warn(
        `[SpeechService] stream error mid-stream — id=${utteranceId} seq=${seq} err=${err instanceof Error ? err.message : String(err)}`,
      );
      if (layer && !layerFinalized) {
        this.unregisterLayer(layerId);
      }
    }

    this.queue.shift();
  }
}
