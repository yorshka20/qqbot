/**
 * A single chunk emitted by `synthesizeStream`. Each chunk carries raw audio
 * bytes and stable metadata. Exactly one chunk per stream has `isLast=true`;
 * that terminator chunk may carry `totalDurationMs`. The terminator may have
 * zero-length `bytes` (preferred — guarantees a final message even when the
 * provider sends no trailing data frame).
 */
export interface SynthesisChunk {
  bytes: Uint8Array;
  mime: string;
  sampleRate?: number;
  isLast: boolean;
  totalDurationMs?: number;
}

/** Raw audio output from a TTS synthesis call. */
export interface SynthesisResult {
  bytes: Uint8Array;
  mime: string;
  durationMs: number;
  sampleRate?: number;
}

/** Per-call options for synthesis. */
export interface TTSSynthesizeOptions {
  voice?: string;
}

/** Common interface for all bot-level TTS backends. */
export interface TTSProvider {
  readonly name: string;
  isAvailable(): boolean;
  healthCheck?(): Promise<boolean>;
  synthesize(text: string, opts?: TTSSynthesizeOptions): Promise<SynthesisResult>;
  listVoices?(): string[];
  synthesizeStream?(text: string, opts?: TTSSynthesizeOptions): AsyncIterable<SynthesisChunk>;
  warmup?(): Promise<void>;
}
