// Shared markdown renderer for the `<memory_context>` block.
//
// Used by both the main ConversationPipeline (one speaker per turn) and the
// Live2D pipeline (0–N speakers per batch, bilibili-danmaku-batch being the
// driver). Keeping the formatter here means the two pipelines can't drift
// on header text or speaker tag shape.
//
// Output shape (only non-empty sections are emitted):
//
//   ## 关于本群的记忆
//   [scope]
//   ...
//
//   ## 关于用户的记忆
//   ### [speaker:<uid>:<nick>]
//   [scope]
//   ...
//
//   ### [speaker:<uid>:<nick>]
//   [scope]
//   ...
//
// The speaker tag mirrors `PromptMessageAssembler.serializeEntry`'s history
// prefix exactly so the LLM sees one consistent schema — uid first for
// precise alignment, nick second for human readability.
//
// `nick` is stripped of `[`, `]`, `:` and angle brackets because those are
// structural in the surrounding tag grammar (and TTS can't pronounce them
// anyway). Empty nick is preserved as a trailing `:` to keep the arity
// identical to `[speaker:${uid}:${nick}]` in `serializeEntry`.

export interface MemorySpeakerSection {
  /** Raw user id — emitted verbatim inside the speaker tag. */
  uid: string;
  /** Display name — structural characters stripped before emission. */
  nick?: string;
  /** RAG/text-concat output for this user. Falsy/whitespace-only is dropped. */
  memoryText: string;
}

export interface FormatMemoryMarkdownInput {
  /** Group-level memory text (already merged manual + auto). */
  groupMemoryText?: string;
  /** One entry per speaker whose memory should be rendered. */
  userSections?: MemorySpeakerSection[];
}

/**
 * Render the group + per-speaker memory block. Returns an empty string when
 * every slot is empty so the assembler can drop the `<memory_context>`
 * wrapper entirely (no "here's memory: [nothing]" for the LLM to parse).
 */
export function formatMemoryMarkdown(input: FormatMemoryMarkdownInput): string {
  const parts: string[] = [];

  const groupText = input.groupMemoryText?.trim();
  if (groupText) {
    parts.push(`## 关于本群的记忆\n${groupText}`);
  }

  const speakerBlocks: string[] = [];
  for (const section of input.userSections ?? []) {
    const memoryText = section.memoryText?.trim();
    if (!memoryText) continue;
    const speakerTag = buildSpeakerTag(section.uid, section.nick);
    speakerBlocks.push(`### ${speakerTag}\n${memoryText}`);
  }

  if (speakerBlocks.length > 0) {
    parts.push(`## 关于用户的记忆\n${speakerBlocks.join('\n\n')}`);
  }

  return parts.join('\n\n');
}

/**
 * Build a `[speaker:<uid>:<nick>]` tag matching `PromptMessageAssembler.
 * serializeEntry`'s format. Exported so tests and other renderers can
 * stay in lockstep on the exact string shape.
 */
export function buildSpeakerTag(uid: string, nick?: string): string {
  const safeNick = stripStructuralChars(nick ?? '');
  return `[speaker:${uid}:${safeNick}]`;
}

/**
 * Strip characters that would corrupt the surrounding tag grammar:
 *   `[` `]` — section delimiters
 *   `:`      — field separator inside the speaker tag
 *   `<` `>`  — reserved for XML-ish wrappers (e.g. `<memory_context>`)
 *
 * These are all non-phonetic so losing them doesn't hurt the display
 * name any more than TTS would anyway.
 */
function stripStructuralChars(value: string): string {
  return value.replace(/[[\]:<>]/g, '').trim();
}
