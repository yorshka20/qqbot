import type { SynthesisResult, TTSProvider, TTSSynthesizeOptions } from '../TTSProvider';

export interface SovitsProviderOptions {
  endpoint: string;
  /** JSON body template; use `{text}` and `{voice}` as placeholders. */
  bodyTemplate: Record<string, unknown>;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  responseFormat?: 'audio/wav' | 'audio/mpeg';
  defaultVoice?: string;
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

export class SovitsProvider implements TTSProvider {
  readonly name = 'sovits';

  private readonly endpoint: string;
  private readonly bodyTemplate: Record<string, unknown>;
  private readonly method: 'GET' | 'POST';
  private readonly headers: Record<string, string>;
  private readonly responseFormat: 'audio/wav' | 'audio/mpeg' | undefined;
  private readonly defaultVoice: string | undefined;

  constructor(options: SovitsProviderOptions) {
    this.endpoint = options.endpoint;
    this.bodyTemplate = options.bodyTemplate;
    this.method = options.method ?? 'POST';
    this.headers = options.headers ?? { 'Content-Type': 'application/json' };
    this.responseFormat = options.responseFormat;
    this.defaultVoice = options.defaultVoice;
  }

  isAvailable(): boolean {
    return typeof this.endpoint === 'string' && this.endpoint.length > 0;
  }

  async synthesize(text: string, opts?: TTSSynthesizeOptions): Promise<SynthesisResult> {
    const voice = opts?.voice ?? this.defaultVoice;
    const body = substitutePlaceholders(this.bodyTemplate, { text, voice });

    const response = await globalThis.fetch(this.endpoint, {
      method: this.method,
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Sovits TTS request failed: ${response.status} ${response.statusText}`);
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
}
