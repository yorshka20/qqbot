/** Raw audio output from a TTS synthesis call. */
export interface SynthesisResult {
  /** Raw audio bytes (PCM, MP3, WAV, etc.). */
  bytes: Uint8Array;
  /** MIME type of the audio, e.g. 'audio/mpeg' or 'audio/wav'. */
  mime: string;
  /** Estimated or actual duration of the audio in milliseconds. */
  durationMs: number;
  /** Optional sample rate in Hz, if known from the provider response. */
  sampleRate?: number;
}

/** Per-call options for synthesis. */
export interface TTSSynthesizeOptions {
  /** Provider-specific voice identifier or reference ID. */
  voice?: string;
}

/**
 * Common interface for all TTS backends.
 *
 * Implementations should be lightweight value objects (no tsyringe DI required).
 * Register them with `TTSManager` to make them available to the rest of the system.
 */
export interface TTSProvider {
  /** Stable identifier, e.g. 'fish-audio', 'sovits'. Must be unique in the registry. */
  readonly name: string;

  /**
   * Returns true when the provider is usable (API key present, endpoint reachable, etc.).
   * Callers may skip unavailable providers rather than throwing.
   */
  isAvailable(): boolean;

  /**
   * Synthesize `text` into audio.
   * @param text  The text to convert.
   * @param opts  Optional per-call overrides (voice, etc.).
   * @returns A `SynthesisResult` with raw audio bytes and metadata.
   */
  synthesize(text: string, opts?: TTSSynthesizeOptions): Promise<SynthesisResult>;

  /**
   * Optional: enumerate voice names the provider exposes. Used by UIs / the
   * `/tts list` command to render a pickable voice menu. Providers without a
   * discrete voice catalog (free-form endpoints, single-voice models) can
   * omit this method.
   */
  listVoices?(): string[];
}
