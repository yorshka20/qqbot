import type { SynthesisResult, TTSProvider, TTSSynthesizeOptions } from '../TTSProvider';

export interface FishAudioProviderOptions {
  name?: string;
  apiKey: string;
  voiceMap: Record<string, string>;
  defaultVoice: string;
  model?: string;
  format?: 'mp3' | 'wav';
  endpoint?: string;
}

export class FishAudioProvider implements TTSProvider {
  readonly name: string;

  private readonly apiKey: string;
  private readonly voiceMap: Record<string, string>;
  private readonly defaultVoice: string;
  private readonly model: string;
  private readonly format: 'mp3' | 'wav';
  private readonly endpoint: string;

  constructor(options: FishAudioProviderOptions) {
    this.name = options.name ?? 'fish-audio';
    this.apiKey = options.apiKey;
    this.voiceMap = options.voiceMap;
    this.defaultVoice = options.defaultVoice;
    this.model = options.model ?? 's1';
    this.format = options.format ?? 'mp3';
    this.endpoint = options.endpoint ?? 'https://api.fish.audio/v1/tts';
  }

  isAvailable(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  listVoices(): string[] {
    return Object.keys(this.voiceMap);
  }

  /**
   * Lightweight reachability + auth probe: POST minimal JSON to the configured
   * endpoint with a short timeout. Does not guarantee quota/billing health,
   * but catches DNS/TLS/network/auth failures early for fallback routing.
   */
  async healthCheck(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    let referenceId: string | undefined;
    if (this.defaultVoice && this.voiceMap[this.defaultVoice]) {
      referenceId = this.voiceMap[this.defaultVoice];
    } else if (this.defaultVoice) {
      referenceId = this.defaultVoice;
    }

    const body: Record<string, unknown> = { text: 'ping', format: this.format };
    if (referenceId) {
      body.reference_id = referenceId;
    }

    let response: Response;
    try {
      response = await globalThis.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          model: this.model,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      return false;
    }

    // Consume body so the connection can be reused; healthCheck does not need audio bytes.
    try {
      await response.arrayBuffer();
    } catch {
      /* ignore */
    }

    if (response.status === 401 || response.status === 403) {
      return false;
    }

    return response.ok;
  }

  async synthesize(text: string, opts?: TTSSynthesizeOptions): Promise<SynthesisResult> {
    const voiceKey = opts?.voice;
    let referenceId: string | undefined;
    if (voiceKey && this.voiceMap[voiceKey]) {
      referenceId = this.voiceMap[voiceKey];
    } else if (this.defaultVoice && this.voiceMap[this.defaultVoice]) {
      referenceId = this.voiceMap[this.defaultVoice];
    } else if (this.defaultVoice) {
      referenceId = this.defaultVoice;
    }

    const body: Record<string, unknown> = { text, format: this.format };
    if (referenceId) {
      body.reference_id = referenceId;
    }

    const response = await globalThis.fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        model: this.model,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`FishAudio TTS request failed: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const mime = this.format === 'wav' ? 'audio/wav' : 'audio/mpeg';

    return {
      bytes,
      mime,
      durationMs: bytes.length / 4000,
    };
  }

}
