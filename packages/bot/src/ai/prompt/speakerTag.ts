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
