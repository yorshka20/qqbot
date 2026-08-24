/** LLM-facing voice channel settings (`tts.voiceReply` in config). */
export interface VoiceReplyConfig {
  /** Expose the `speak` tool to the reply LLM. */
  enabled?: boolean;
  /** Voice messages the LLM may send within one reply. */
  maxPerReply?: number;
  /** Spoken-character budget per voice message; inline cues don't count. */
  maxTextLength?: number;
  /** Provider the tool synthesizes with; defaults to `tts.defaultProvider`. */
  provider?: string;
}

export type ResolvedVoiceReplyConfig = Required<Omit<VoiceReplyConfig, 'provider'>> & { provider?: string };

/**
 * Voice is intrusive in a chat — it can't be skimmed, and in a group everyone
 * pays for it. The defaults keep it to a couple of one-breath lines per reply;
 * longer content belongs in text.
 */
const DEFAULTS: ResolvedVoiceReplyConfig = {
  enabled: true,
  maxPerReply: 2,
  maxTextLength: 120,
};

export function resolveVoiceReplyConfig(raw: VoiceReplyConfig | undefined): ResolvedVoiceReplyConfig {
  return {
    enabled: raw?.enabled ?? DEFAULTS.enabled,
    maxPerReply: raw?.maxPerReply ?? DEFAULTS.maxPerReply,
    maxTextLength: raw?.maxTextLength ?? DEFAULTS.maxTextLength,
    ...(raw?.provider ? { provider: raw.provider } : {}),
  };
}
