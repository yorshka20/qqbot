// Shared speaker-tag formatter for prompt assembly.
//
// One canonical format `[speaker:<nick>:<uid>]` is used across the prompt
// surface (history entries, current_query "当前说话人", memory_context user
// headings). Putting the nickname first matches how a human reads a chat
// transcript line — the salient identifier (a name) comes before the
// machine identifier (a numeric uid that the model never needs to recall
// verbatim).
//
// Both fields are emitted unconditionally so the arity is fixed:
//   - missing nick → `[speaker::<uid>]`
//   - missing uid  → `[speaker:<nick>:]`
//   - missing both → `[speaker::]`  (caller should normally drop the tag)
//
// `nick` is stripped of `[`, `]`, `:`, `<`, `>` because those are structural
// in the surrounding tag grammar (`<memory_context>`, `[speaker:…]`, etc.)
// and would corrupt the parse if left in.

import { formatTimeCompact } from '@/utils/dateTime';

export interface SpeakerIdentity {
  /** Raw user id — emitted verbatim. Empty string allowed (falls back to nick-only). */
  uid: string;
  /** Display name — structural characters stripped before emission. */
  nick?: string;
}

/**
 * Build a canonical speaker tag.
 *
 * @param uid - User id (numeric string in practice, but treated as opaque)
 * @param nick - Display name; structural characters are stripped
 */
export function buildSpeakerTag(uid: string, nick?: string): string {
  const safeNick = stripStructuralChars(nick ?? '');
  return `[speaker:${safeNick}:${uid}]`;
}

/**
 * Same as {@link buildSpeakerTag} but accepting a {@link SpeakerIdentity}
 * record, for sites that already carry one around.
 */
export function formatSpeakerTag(identity: SpeakerIdentity): string {
  return buildSpeakerTag(identity.uid, identity.nick);
}

function stripStructuralChars(value: string): string {
  return value.replace(/[[\]:<>]/g, '').trim();
}

/**
 * Build the leading label for a conversation history entry: `[M/DD HH:mm]` then,
 * for user turns only, the speaker tag.
 *
 * The timestamp goes on every turn, the bot's included. Whether a line is minutes
 * or hours old decides whether a topic is still live, and the retrieved
 * `<rag_context>` fragments carry their own timestamps — untimed history would read
 * as less grounded than material pulled from days ago.
 *
 * Only user turns get a speaker tag. The tag exists to tell several humans apart in
 * a group; the bot's own turn is already marked by `role: 'assistant'`, so tagging it
 * adds nothing — and misleads: models read the bot's own nick/uid as another
 * participant ("说话人从 X 变成了 Y，QQ 号不同"), which in a 1:1 chat contradicts the
 * private-chat rule that consecutive user messages are all the same person.
 *
 * Shared by the plain-text assembler and the vision branch, which builds
 * `ContentPart[]` directly; they previously carried separate copies of this rule.
 */
export function buildHistoryEntryPrefix(entry: {
  isBotReply?: boolean;
  userId?: string | number;
  nickname?: string;
  createdAt?: Date;
}): string {
  const time = entry.createdAt ? `[${formatTimeCompact(entry.createdAt)}]` : '';
  if (entry.isBotReply) {
    return time;
  }
  const speaker = buildSpeakerTag(String(entry.userId ?? ''), entry.nickname);
  return time ? `${time} ${speaker}` : speaker;
}
