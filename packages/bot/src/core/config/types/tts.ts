// TTS configuration.
//
// Two shapes are accepted for backward compatibility:
//
// 1. **Multi-provider (preferred, post-2026-04)** — list providers under
//    `providers[]`, pick the default with `defaultProvider`. Each entry's
//    `type` (fish-audio | sovits) picks the implementation class.
//
// 2. **Legacy single-provider** — top-level `apiKey` / `model` / `format`
//    map to a synthesized single-element fish-audio providers array at
//    bootstrap time. Exists so existing user configs don't break.
//
// Bootstrap normalizes both into a `TTSManager`. Downstream code (command
// handler, avatar SpeechService) reads only from `TTSManager` — never
// directly from this config blob.

export interface TTSProviderConfig {
  /** Discriminator: picks which concrete provider class to instantiate. */
  type: 'fish-audio' | 'sovits' | string;
  /** Registry name; defaults to the provider class's built-in name (e.g. 'fish-audio'). */
  name?: string;
  [field: string]: unknown;
}

export interface TTSConfig {
  // ── Multi-provider shape ──
  /** Provider name (matches `providers[].name`) used when callers don't pass `--provider`. */
  defaultProvider?: string;
  providers?: TTSProviderConfig[];

  // ── Legacy single-provider shape (maps to fish-audio) ──
  /** Fish Audio API key. */
  apiKey?: string;
  /** Base model header (s1, speech-1.6, speech-1.5). Default: s1 */
  model?: string;
  /** Fallback `reference_id` when no voice is specified on the call. */
  referenceId?: string;
  /** Audio format (mp3, wav). Default: mp3 */
  format?: string;
  /** Legacy voice name → reference_id map. */
  voiceMap?: Record<string, string>;
  /** Legacy default voice name. */
  defaultVoice?: string;
}
