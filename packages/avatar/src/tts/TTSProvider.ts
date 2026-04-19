export interface SynthesisResult {
  bytes: Uint8Array; // raw audio bytes
  mime: string; // 'audio/mpeg' / 'audio/wav'
  durationMs: number; // actual duration (decode-derived or provider-returned)
  sampleRate?: number; // optional, provider-dependent
}

export interface TTSSynthesizeOptions {
  voice?: string; // provider-specific voice / reference id
}

export interface TTSProvider {
  readonly name: string; // 'fish-audio-stub' / 'sovits' / ...
  isAvailable(): boolean; // config present, API key set, etc.
  synthesize(text: string, opts?: TTSSynthesizeOptions): Promise<SynthesisResult>;
}
