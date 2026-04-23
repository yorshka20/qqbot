import type { SynthesisChunk, SynthesisResult, TTSProvider, TTSSynthesizeOptions } from '../TTSProvider';

export interface SovitsProviderOptions {
  /** Registry name. Defaults to `'sovits'`; override when registering multiple SoVITS instances. */
  name?: string;
  endpoint: string;
  /** JSON body template; use `{text}` and `{voice}` as placeholders. */
  bodyTemplate: Record<string, unknown>;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  responseFormat?: 'audio/wav' | 'audio/mpeg';
  defaultVoice?: string;
  /**
   * Required sample rate (Hz) when streaming raw PCM audio
   * (`bodyTemplate.streaming_mode` truthy AND `bodyTemplate.media_type === 'raw'`).
   * Passed through to each yielded `SynthesisChunk` so the renderer can
   * initialise its AudioContext at the correct rate. Ignored for non-PCM paths.
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
  private readonly responseFormat: 'audio/wav' | 'audio/mpeg' | undefined;
  private readonly defaultVoice: string | undefined;
  private readonly pcmSampleRate: number | undefined;

  constructor(options: SovitsProviderOptions) {
    this.name = options.name ?? 'sovits';
    this.endpoint = options.endpoint;
    this.bodyTemplate = options.bodyTemplate;
    this.method = options.method ?? 'POST';
    this.headers = options.headers ?? { 'Content-Type': 'application/json' };
    this.responseFormat = options.responseFormat;
    this.defaultVoice = options.defaultVoice;
    this.pcmSampleRate = options.pcmSampleRate;
  }

  isAvailable(): boolean {
    return typeof this.endpoint === 'string' && this.endpoint.length > 0;
  }

  async synthesize(text: string, opts?: TTSSynthesizeOptions): Promise<SynthesisResult> {
    const voice = opts?.voice ?? this.defaultVoice;
    const trimmedText = text.trim();
    const body = substitutePlaceholders(this.bodyTemplate, { text: trimmedText, voice });

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

    const contentType = response.headers.get('Content-Type') ?? '';
    const mime = this.responseFormat ?? (contentType.includes('wav') ? 'audio/wav' : 'audio/mpeg');

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    return {
      bytes,
      mime,
      durationMs: bytes.length / 4000,
    };
  }

  /**
   * Stream raw PCM audio from Sovits. Only supported when the body template
   * has `streaming_mode` truthy AND `media_type === 'raw'`. Throws immediately
   * if these conditions are not met, or if `pcmSampleRate` is missing.
   *
   * Each yielded chunk carries `mime='audio/pcm'` and the configured
   * `sampleRate`. The stream ends with a single terminator chunk where
   * `isLast=true` and `bytes` is an empty `Uint8Array`.
   *
   * Throws on any non-2xx response or stream-read failure.
   */
  async *synthesizeStream(text: string, opts?: TTSSynthesizeOptions): AsyncIterable<SynthesisChunk> {
    const streamingMode = this.bodyTemplate.streaming_mode;
    const mediaType = this.bodyTemplate.media_type;

    if (!streamingMode || mediaType !== 'raw') {
      throw new Error(
        'SovitsProvider.synthesizeStream requires bodyTemplate.streaming_mode to be truthy and bodyTemplate.media_type === "raw"',
      );
    }

    if (this.pcmSampleRate === undefined) {
      throw new Error('SovitsProvider.synthesizeStream requires pcmSampleRate to be configured');
    }

    const sampleRate = this.pcmSampleRate;
    const voice = opts?.voice ?? this.defaultVoice;
    const trimmedText = text.trim();
    const body = substitutePlaceholders(this.bodyTemplate, { text: trimmedText, voice });

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
        if (value && value.length > 0) {
          yield {
            bytes: value,
            mime,
            sampleRate,
            isLast: false,
          };
        }
      }
    } finally {
      reader.releaseLock();
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
