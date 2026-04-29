export type AvatarSource = 'avatar-cmd' | 'bilibili-danmaku-batch' | 'livemode-private-batch';

/**
 * One distinct sender contributing to a multi-user Live2D input batch
 * (currently only `bilibili-danmaku-batch`). Forwarded through
 * `AvatarBatchSender.senders` so the prompt stage can fan out per-user
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
