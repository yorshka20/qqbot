import { renderCues } from '../speechCues';
import type { SynthesisResult, TTSCapabilities, TTSProvider, TTSSynthesizeOptions } from '../TTSProvider';

/**
 * Cue words worth teaching a chat LLM, from the documented set at
 * https://docs.fish.audio/developer-guide/core-features/emotions (64+ emotions
 * plus tone/sound-effect markers). Kept to the ones that read naturally in a
 * short chat voice message — the models also accept free-form descriptions,
 * so this is a starting vocabulary, not a whitelist.
 */
const FISH_CUE_VOCABULARY = [
  'happy',
  'sad',
  'excited',
  'calm',
  'surprised',
  'curious',
  'sarcastic',
  'proud',
  'grateful',
  'confused',
  'disappointed',
  'nostalgic',
  'bored',
  'whispering',
  'shouting',
  'soft tone',
  'in a hurry tone',
  'emphasis',
  'laughing',
  'chuckling',
  'sighing',
  'groaning',
  'gasping',
  'yawning',
  'clear throat',
  'break',
  'long-break',
] as const;

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
  readonly capabilities: TTSCapabilities;

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
    this.model = options.model ?? 's2.1-pro';
    this.format = options.format ?? 'mp3';
    this.endpoint = options.endpoint ?? 'https://api.fish.audio/v1/tts';
    // Cue support is a property of the model generation, not of the vendor:
    // only the S2 family reads free-form `[cue]` descriptions. S1's `(cue)`
    // dialect is not implemented — we standardize on S2 — so an S1 config
    // declares no cue support and its markers get stripped instead of spoken.
    const supportsCues = /^s2/i.test(this.model);
    this.capabilities = {
      inlineCues: supportsCues ? 'brackets' : 'none',
      cueVocabulary: supportsCues ? FISH_CUE_VOCABULARY : [],
      prosody: true,
    };
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

    const body: Record<string, unknown> = {
      text: renderCues(text, this.capabilities.inlineCues),
      format: this.format,
    };
    if (referenceId) {
      body.reference_id = referenceId;
    }
    const prosody = this.buildProsody(opts?.prosody);
    if (prosody) {
      body.prosody = prosody;
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

  /** Map bot-level prosody onto the API's `prosody` object (speed 0.5–2.0, volume in dB). */
  private buildProsody(prosody: TTSSynthesizeOptions['prosody']): Record<string, number> | null {
    if (!prosody) {
      return null;
    }
    const out: Record<string, number> = {};
    if (prosody.speed !== undefined) {
      out.speed = Math.min(2, Math.max(0.5, prosody.speed));
    }
    if (prosody.volumeDb !== undefined) {
      out.volume = prosody.volumeDb;
    }
    return Object.keys(out).length > 0 ? out : null;
  }
}
