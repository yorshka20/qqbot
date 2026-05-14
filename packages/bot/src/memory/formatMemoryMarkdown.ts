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
//   ### [speaker:<nick>:<uid>]
//   [scope]
//   ...
//
//   ### [speaker:<nick>:<uid>]
//   [scope]
//   ...
//
// The speaker tag is built by {@link buildSpeakerTag} in `ai/prompt/speakerTag.ts`,
// which is the single source of truth — history entries, current_query, and
// memory headings all share the same canonical format.

import { buildSpeakerTag } from '@/ai/prompt/speakerTag';

export { buildSpeakerTag } from '@/ai/prompt/speakerTag';

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

