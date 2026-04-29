// Avatar pipeline input/output types. Kept in a leaf module (no deps on
// stages or the pipeline itself) so stage files can import them without
// creating import cycles with the orchestrator.

export type Live2DSource = 'avatar-cmd' | 'bilibili-danmaku-batch' | 'livemode-private-batch';

/**
 * One distinct sender contributing to a multi-user Live2D input batch
 * (currently only `bilibili-danmaku-batch`). Forwarded through
 * `Live2DInput.meta.senders` so the prompt stage can fan out per-user
 * memory lookups instead of being limited to a single `sender.uid`.
 *
 * - `uid`  — platform-native user id (string-form; bilibili uid is numeric
 *   but we carry it as string for filesystem-safe sanitization downstream).
 * - `name` — last-seen display name in this batch. May be empty if the
 *   platform didn't provide one (falls back to `[speaker:<uid>:]`).
 * - `text` — concatenation of this user's raw danmaku lines in this batch,
 *   joined by `\n`. Used as the RAG `userMessage` for this user's memory
 *   lookup so results are semantically scoped to *what they said*, not to
 *   the whole batch. Optional: callers may omit it and consumers fall back
 *   to the batch-wide text.
 */
export interface AvatarBatchSender {
  uid: string;
  name: string;
  text?: string;
}

export interface Live2DInput {
  /** Raw text to feed the LLM. Batch sources should pre-format (see DanmakuBuffer). */
  text: string;
  source: Live2DSource;
  /**
   * Optional single-sender tag. Used by `avatar-cmd` (admin probe, no
   * sender) and `livemode-private-batch` (one mocked user). For
   * `bilibili-danmaku-batch` use `meta.senders` instead — the batch holds
   * N distinct viewers and a single-valued sender would drop information.
   */
  sender?: { name?: string; uid?: string };
  /**
   * Free-form metadata. Not sent to the LLM as user text.
   * - `temperature` (number): LLM temperature for this run.
   * - `llmStream` (boolean): if set, overrides `avatar.llmStream` for API stream vs one-shot `generate`.
   * - `senders` (`AvatarBatchSender[]`): populated by `BilibiliLiveBridge`
   *   for danmaku batches. Distinct viewers aggregated from the flush
   *   payload. Prompt stage fans out per-user memory lookups across them.
   */
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
  | 'bad-llm-reply';
