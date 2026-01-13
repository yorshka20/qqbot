// TTS configuration

export interface TTSConfig {
  // Fish Audio API key
  apiKey: string;
  // Base model to use in header (s1, speech-1.6, speech-1.5)
  // Default: s1
  model?: string;
  // Custom voice model ID (reference_id) to use in request body
  // If not specified, uses the base model
  referenceId?: string;
  // Audio format (mp3, wav, etc.)
  // Default: mp3
  format?: string;
}
