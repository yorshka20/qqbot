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

/**
 * Whether a backend understands inline delivery cues (emotion / tone / sound
 * effects) embedded in the text, e.g. `[whispering]`.
 *
 * - `brackets`: cues pass through as written (Fish Audio S2 family).
 * - `none`: the backend would read the markers aloud, so they must be removed
 *   before synthesis. Everything that isn't an S2-class model lands here —
 *   Fish Audio S1's `(cue)` dialect is deliberately not supported.
 */
export type InlineCueSyntax = 'brackets' | 'none';

/** What a backend can actually do with a rendered speech script. */
export interface TTSCapabilities {
  inlineCues: InlineCueSyntax;
  /**
   * Cue words the backend documents, without syntax decoration ('happy',
   * 'whispering', 'break'). Empty when `inlineCues` is 'none'. Callers that
   * teach a cue vocabulary to an LLM read it from here so the taught set can
   * never drift from the backend that renders it.
   */
  cueVocabulary: readonly string[];
  /** Whether per-call speed/volume in {@link TTSProsody} reaches the backend. */
  prosody: boolean;
}

/** Per-call delivery shaping, applied to the whole utterance. */
export interface TTSProsody {
  /** Speech rate multiplier; 1 = the backend's own default. */
  speed?: number;
  /** Volume offset in dB relative to the backend's default. */
  volumeDb?: number;
}

/** Per-call options for synthesis. */
export interface TTSSynthesizeOptions {
  voice?: string;
  prosody?: TTSProsody;
}

/**
 * Common interface for all bot-level TTS backends.
 *
 * Contract on `text`: callers pass a speech script that may carry inline
 * `[cue]` markers. Rendering that script into the backend's wire format
 * (pass through / rewrite to `(cue)` / strip) is the provider's job, not the
 * caller's — otherwise every call site would have to branch on the resolved
 * provider, and the health-based fallback path (which can swap the provider
 * mid-call) would silently emit cues into a backend that reads them aloud.
 */
export interface TTSProvider {
  readonly name: string;
  readonly capabilities: TTSCapabilities;
  isAvailable(): boolean;
  healthCheck?(): Promise<boolean>;
  synthesize(text: string, opts?: TTSSynthesizeOptions): Promise<SynthesisResult>;
  listVoices?(): string[];
  synthesizeStream?(text: string, opts?: TTSSynthesizeOptions): AsyncIterable<SynthesisChunk>;
  warmup?(): Promise<void>;
}
