// Live2DPipeline input/output types. Kept in a leaf module (no deps on
// stages or the pipeline itself) so stage files can import them without
// creating import cycles with the orchestrator.

export type Live2DSource = 'avatar-cmd' | 'bilibili-danmaku-batch';

export interface Live2DInput {
  /** Raw text to feed the LLM. Batch sources should pre-format (see DanmakuBuffer). */
  text: string;
  source: Live2DSource;
  /** Optional sender tag for logging / future routing. */
  sender?: { name?: string; uid?: string };
  /** Free-form metadata attached to logs. Not sent to the LLM. */
  meta?: Record<string, unknown>;
}

export interface Live2DResult {
  /** Raw LLM reply with tags still in place. */
  replyText: string;
  /** Reply with Live2D tags stripped — what gets spoken / returned. */
  spoken: string;
  /** Number of parsed Live2D tags queued onto the animation compiler. */
  tagCount: number;
  /** True when the input was dropped without a full LLM round-trip. */
  skipped: boolean;
  /** Populated when `skipped=true` to explain why. */
  skipReason?: string;
}

/** Skip reasons surfaced through Live2DResult.skipReason. Kept as a union so
 * callers (e.g. AvatarCommandHandler) can exhaustively map them to UI text. */
export type Live2DSkipReason =
  | 'avatar-inactive'
  | 'no-consumer'
  | 'prompt-render-failed'
  | 'llm-failed'
  | 'empty-reply'
  | 'backlog-overflow';
