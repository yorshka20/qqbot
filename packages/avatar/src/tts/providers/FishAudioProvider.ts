import type { SynthesisResult, TTSProvider, TTSSynthesizeOptions } from '../TTSProvider';

export interface FishAudioProviderOptions {
  /** Registry name. Defaults to `'fish-audio'`; override when registering multiple fish-audio configs. */
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

  /** Names registered in this provider's voiceMap, in declaration order. */
  listVoices(): string[] {
    return Object.keys(this.voiceMap);
  }

  async synthesize(text: string, opts?: TTSSynthesizeOptions): Promise<SynthesisResult> {
    // Resolve reference_id: opts.voice -> voiceMap[opts.voice] -> voiceMap[defaultVoice] -> defaultVoice
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
