import { logger } from '../../utils/logger';
import type { SynthesisChunk, SynthesisResult, TTSProvider, TTSSynthesizeOptions } from '../TTSProvider';

export interface SovitsProviderOptions {
  /** Registry name. Defaults to `'sovits'`; override when registering multiple SoVITS instances. */
  name?: string;
  endpoint: string;
  /**
   * JSON body template; use `{text}` and `{voice}` as placeholders.
   *
   * The template should carry only *stable* synthesis params (e.g.
   * `text_lang`, `ref_audio_path`, `prompt_text`, `prompt_lang`). Streaming
   * fields — `streaming_mode` and `media_type` — are owned by the provider
   * and forced per-method:
   *   - `synthesize()` overrides to `{streaming_mode: false, media_type: 'wav'}`
   *     so Milky `record` segments (QQ voice message) receive a proper WAV
   *     rather than undecodable raw-PCM bytes labelled as wav.
   *   - `synthesizeStream()` overrides to `{streaming_mode: true, media_type: 'raw'}`
   *     so the renderer / Live2D path gets chunked PCM.
   * Any `streaming_mode` / `media_type` the caller puts in the template is
   * silently overwritten.
   */
  bodyTemplate: Record<string, unknown>;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  defaultVoice?: string;
  /**
   * Sample rate (Hz) of the PCM stream returned by the server in streaming
   * mode. Required for `synthesizeStream()` (passed through to each yielded
   * `SynthesisChunk` so the renderer can initialise its AudioContext at the
   * correct rate). Ignored by non-streaming `synthesize()`, whose WAV
   * response carries its own sample rate in the file header.
   */
  pcmSampleRate?: number;
}

/**
 * Recursively traverse `template` and replace `{text}` and `{voice}` inside
 * string values. Does **not** mutate the original object. If `voice` is not
 * provided, `{voice}` placeholders are left unchanged.
 */
export function substitutePlaceholders(
  template: Record<string, unknown>,
  replacements: { text: string; voice?: string },
): Record<string, unknown> {
  return substituteValue(template, replacements) as Record<string, unknown>;
}

function substituteValue(value: unknown, replacements: { text: string; voice?: string }): unknown {
  if (typeof value === 'string') {
    let result = value.replace(/\{text\}/g, replacements.text);
    if (replacements.voice !== undefined) {
      result = result.replace(/\{voice\}/g, replacements.voice);
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteValue(item, replacements));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteValue(v, replacements);
    }
    return out;
  }
  return value;
}

/** GPT-SoVITS api_v2 often returns { message, Exception }; `message` may be the generic "tts failed". */
function formatProviderJsonError(j: Record<string, unknown>): string {
  const parts: string[] = [];
  const msg = j.message;
  if (typeof msg === 'string' && msg.length > 0) {
    parts.push(msg);
  }
  const ex = j.Exception;
  if (typeof ex === 'string' && ex.length > 0 && ex !== msg) {
    const short = ex.length > 1200 ? `${ex.slice(0, 1200)}…` : ex;
    parts.push(short);
  }
  if (parts.length > 0) {
    return parts.join(' | ');
  }
  return JSON.stringify(j).slice(0, 800);
}

async function readHttpErrorDetail(response: Response): Promise<string> {
  const raw = new TextDecoder().decode(await response.arrayBuffer());
  if (raw.length === 0) {
    return response.statusText;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as Record<string, unknown>;
      return formatProviderJsonError(j);
    } catch {
      return trimmed.slice(0, 500);
    }
  }
  return trimmed.slice(0, 500);
}

export class SovitsProvider implements TTSProvider {
  readonly name: string;

  private readonly endpoint: string;
  private readonly bodyTemplate: Record<string, unknown>;
  private readonly method: 'GET' | 'POST';
  private readonly headers: Record<string, string>;
  private readonly defaultVoice: string | undefined;
  private readonly pcmSampleRate: number | undefined;

  constructor(options: SovitsProviderOptions) {
    this.name = options.name ?? 'sovits';
    this.endpoint = options.endpoint;
    this.bodyTemplate = options.bodyTemplate;
    this.method = options.method ?? 'POST';
    this.headers = options.headers ?? { 'Content-Type': 'application/json' };
    this.defaultVoice = options.defaultVoice;
    this.pcmSampleRate = options.pcmSampleRate;
  }

  isAvailable(): boolean {
    return typeof this.endpoint === 'string' && this.endpoint.length > 0;
  }

  /**
   * Synthesize the full utterance into a single WAV buffer.
   *
   * Always requests `streaming_mode: false` + `media_type: 'wav'` so the
   * response is a complete, self-describing WAV file. This is required by
   * the `/tts` command path: the Milky `record` segment it produces cannot
   * carry chunked raw PCM — the backend rejects it with "消息体无法解析"
   * (500 Internal error). Any streaming fields in the configured
   * `bodyTemplate` are overwritten.
   */
  async synthesize(text: string, opts?: TTSSynthesizeOptions): Promise<SynthesisResult> {
    const voice = opts?.voice ?? this.defaultVoice;
    const trimmedText = text.trim();
    const body = substitutePlaceholders(
      { ...this.bodyTemplate, streaming_mode: false, media_type: 'wav' },
      { text: trimmedText, voice },
    );

    const init: RequestInit = {
      method: this.method,
      headers: this.headers,
    };
    if (this.method !== 'GET') {
      init.body = JSON.stringify(body);
    }

    const response = await globalThis.fetch(this.endpoint, init);

    if (!response.ok) {
      const detail = await readHttpErrorDetail(response);
      throw new Error(
        `Sovits TTS request failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`,
      );
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Mime is fixed because we asked the server for wav above. The
    // Content-Type header is ignored — some GPT-SoVITS builds mislabel
    // it as `audio/x-wav` or even `application/octet-stream`, and we don't
    // want that leaking into downstream consumers that switch on mime.
    return {
      bytes,
      mime: 'audio/wav',
      durationMs: bytes.length / 4000,
    };
  }

  /**
   * Stream raw PCM audio from Sovits. Always requests
   * `streaming_mode: true` + `media_type: 'raw'` — any such fields in the
   * configured `bodyTemplate` are overwritten.
   *
   * Requires `pcmSampleRate` to be configured (raw PCM has no in-band
   * sample rate; the renderer needs it to init its AudioContext).
   *
   * Each yielded chunk carries `mime='audio/pcm'` and the configured
   * `sampleRate`. The stream ends with a single terminator chunk where
   * `isLast=true` and `bytes` is an empty `Uint8Array`.
   *
   * Throws on any non-2xx response or stream-read failure.
   */
  async *synthesizeStream(text: string, opts?: TTSSynthesizeOptions): AsyncIterable<SynthesisChunk> {
    if (this.pcmSampleRate === undefined) {
      throw new Error('SovitsProvider.synthesizeStream requires pcmSampleRate to be configured');
    }

    const sampleRate = this.pcmSampleRate;
    const voice = opts?.voice ?? this.defaultVoice;
    const trimmedText = text.trim();
    const body = substitutePlaceholders(
      { ...this.bodyTemplate, streaming_mode: true, media_type: 'raw' },
      { text: trimmedText, voice },
    );

    const init: RequestInit = {
      method: this.method,
      headers: this.headers,
    };
    if (this.method !== 'GET') {
      init.body = JSON.stringify(body);
    }

    const response = await globalThis.fetch(this.endpoint, init);

    if (!response.ok) {
      const detail = await readHttpErrorDetail(response);
      throw new Error(
        `Sovits TTS request failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`,
      );
    }

    if (!response.body) {
      throw new Error('Sovits TTS streaming response has no body');
    }

    const reader = response.body.getReader();
    const mime = 'audio/pcm';

    // Sample alignment state. HTTP chunked transfer splits the byte stream at
    // arbitrary positions, but s16le samples are 2 bytes each. If we yielded
    // a chunk whose length isn't a multiple of SAMPLE_BYTES, the downstream
    // per-chunk decoders (lip-sync RMS pipeline AND the renderer) would
    // Math.floor() away the trailing byte and then treat the next chunk's
    // first byte as the *high* byte of a new sample — shifting the int16
    // grid by 1 for the rest of the stream. Result: white noise.
    //
    // Solution: buffer any trailing sub-sample bytes and prepend them to the
    // next incoming chunk. Only yield when we have ≥1 complete sample.
    //
    // The renderer currently assumes s16le (see SpeechPlayer.decodePcmToAudioBuffer).
    // If a future config introduces f32, SAMPLE_BYTES should be derived from
    // the configured format.
    const SAMPLE_BYTES = 2;
    let residual = new Uint8Array(0);

    try {
      while (true) {
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          const readResult = await reader.read();
          done = readResult.done;
          value = readResult.value;
        } catch (err) {
          throw new Error(`Sovits TTS stream read failure: ${String(err)}`);
        }
        if (done) {
          break;
        }
        if (!value || value.length === 0) {
          continue;
        }

        // Merge residual with the newly-read bytes into a fresh buffer we
        // own. Always copying avoids aliasing issues with `reader.read()`
        // returning views over a shared ArrayBufferLike.
        const combined = new Uint8Array(residual.length + value.length);
        combined.set(residual, 0);
        combined.set(value, residual.length);

        const alignedLen = combined.length - (combined.length % SAMPLE_BYTES);
        if (alignedLen === 0) {
          // Not even one full sample — hold everything for the next read.
          residual = combined;
          continue;
        }

        // slice() both halves so the yielded chunk and the carried residual
        // each own their buffer — avoids surprises if the consumer holds on
        // to `bytes` across multiple reader iterations.
        const alignedChunk = combined.slice(0, alignedLen);
        residual = combined.slice(alignedLen);

        yield {
          bytes: alignedChunk,
          mime,
          sampleRate,
          isLast: false,
        };
      }
    } finally {
      reader.releaseLock();
    }

    // If the producer sent a well-formed stream, residual should be empty at
    // EOS. A non-empty residual means the backend closed the connection mid-
    // sample — we log and drop rather than emitting a misaligned chunk.
    if (residual.length > 0) {
      logger.warn(
        `[SovitsProvider] stream ended with ${residual.length} orphan byte(s); dropping (expected multiple of ${SAMPLE_BYTES})`,
      );
    }

    // Terminator chunk — guarantees a final isLast=true message.
    yield {
      bytes: new Uint8Array(0),
      mime,
      sampleRate,
      isLast: true,
    };
  }

  /**
   * Tiny dummy synthesize to force the GPT-SoVITS engine to load the
   * currently-configured reference audio + model weights into memory before
   * the first real user utterance arrives. Without this, the first real
   * synth pays ~1–3s of cold-start overhead on top of normal inference.
   *
   * We intentionally use a single Chinese character so the request is valid
   * under almost any `text_split_method` + language combination. Errors are
   * swallowed — the caller already treats warmup as fire-and-forget, and we
   * don't want a flaky warmup to crash bootstrap.
   */
  async warmup(): Promise<void> {
    try {
      await this.synthesize('你');
    } catch {
      /* swallow — warmup is best-effort */
    }
  }
}
