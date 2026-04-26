import { logger } from '@/utils/logger';
import type { SynthesisChunk, SynthesisResult, TTSProvider, TTSSynthesizeOptions } from '../TTSProvider';

export interface SovitsProviderOptions {
  name?: string;
  endpoint: string;
  bodyTemplate: Record<string, unknown>;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  defaultVoice?: string;
  pcmSampleRate?: number;
}

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

function formatProviderJsonError(j: Record<string, unknown>): string {
  const parts: string[] = [];
  const msg = j.message;
  if (typeof msg === 'string' && msg.length > 0) {
    parts.push(msg);
  }
  const ex = j.Exception;
  if (typeof ex === 'string' && ex.length > 0 && ex !== msg) {
    const short = ex.length > 1200 ? `${ex.slice(0, 1200)}...` : ex;
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
   * Best-effort probe of the configured SoVITS HTTP endpoint.
   * Uses the same non-streaming payload shape as `synthesize()`, with a hard timeout,
   * and treats only transport/HTTP failures as unhealthy (consumes response body).
   */
  async healthCheck(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    if (this.method === 'GET') {
      try {
        const response = await globalThis.fetch(this.endpoint, { method: 'GET', headers: this.headers });
        try {
          await response.arrayBuffer();
        } catch {
          /* ignore */
        }
        return response.ok;
      } catch {
        return false;
      }
    }

    const voice = this.defaultVoice;
    const trimmedText = '你';
    const body = substitutePlaceholders(
      { ...this.bodyTemplate, streaming_mode: false, media_type: 'wav' },
      { text: trimmedText, voice },
    );

    try {
      const response = await globalThis.fetch(this.endpoint, {
        method: this.method,
        headers: this.headers,
        body: JSON.stringify(body),
      });
      try {
        await response.arrayBuffer();
      } catch {
        /* ignore */
      }
      return response.ok;
    } catch {
      return false;
    }
  }

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
        `Sovits TTS request failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`,
      );
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    return {
      bytes,
      mime: 'audio/wav',
      durationMs: bytes.length / 4000,
    };
  }

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
        `Sovits TTS request failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`,
      );
    }

    if (!response.body) {
      throw new Error('Sovits TTS streaming response has no body');
    }

    const reader = response.body.getReader();
    const mime = 'audio/pcm';
    const sampleBytes = 2;
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

        const combined = new Uint8Array(residual.length + value.length);
        combined.set(residual, 0);
        combined.set(value, residual.length);

        const alignedLen = combined.length - (combined.length % sampleBytes);
        if (alignedLen === 0) {
          residual = combined;
          continue;
        }

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

    if (residual.length > 0) {
      logger.warn(
        `[SovitsProvider] stream ended with ${residual.length} orphan byte(s); dropping (expected multiple of ${sampleBytes})`,
      );
    }

    yield {
      bytes: new Uint8Array(0),
      mime,
      sampleRate,
      isLast: true,
    };
  }

  async warmup(): Promise<void> {
    try {
      await this.synthesize('你');
    } catch {
      /* swallow */
    }
  }

}
