import type { SynthesisResult, TTSProvider, TTSSynthesizeOptions } from './TTSProvider';

export interface FishAudioStubConfig {
  apiKey?: string;
  defaultVoice?: string;
  voiceMap?: Record<string, string>;
  model?: string;
}

export class FishAudioStubProvider implements TTSProvider {
  readonly name = 'fish-audio-stub';

  private readonly apiKey: string | undefined;
  private readonly defaultVoice: string | undefined;
  private readonly voiceMap: Record<string, string>;
  private readonly model: string | undefined;

  constructor(config: FishAudioStubConfig = {}) {
    this.apiKey = config.apiKey;
    this.defaultVoice = config.defaultVoice;
    this.voiceMap = config.voiceMap ?? {};
    this.model = config.model;
  }

  isAvailable(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  async synthesize(text: string, opts?: TTSSynthesizeOptions): Promise<SynthesisResult> {
    const body: Record<string, unknown> = {
      text,
      format: 'mp3',
    };

    if (this.model) {
      body.model = this.model;
    }

    // Resolve reference_id: opts.voice -> voiceMap -> defaultVoice -> omit
    const voiceKey = opts?.voice;
    let referenceId: string | undefined;
    if (voiceKey && this.voiceMap[voiceKey]) {
      referenceId = this.voiceMap[voiceKey];
    } else if (this.defaultVoice && this.voiceMap[this.defaultVoice]) {
      referenceId = this.voiceMap[this.defaultVoice];
    } else if (this.defaultVoice) {
      referenceId = this.defaultVoice;
    }

    if (referenceId) {
      body.reference_id = referenceId;
    }

    const response = await globalThis.fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`FishAudio TTS request failed: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    return {
      bytes,
      mime: 'audio/mpeg',
      durationMs: bytes.length / 4000,
    };
  }
}
