import type { ChatMessage } from '@/ai/types';
import type { ConversationMessageEntry } from '@/conversation/history';
import type { MessageSegment } from '@/message/types';
import { contentToPlainString } from '../utils/contentUtils';
import { buildHistoryEntryPrefix } from './speakerTag';

/** Tag wrapping the turn's actual question. Closes every assembled envelope. */
const CURRENT_QUERY_TAG = 'current_query';

/**
 * True when this message is an envelope built by {@link PromptMessageAssembler} — the
 * context blocks plus the current query — rather than a chat turn.
 *
 * Lives beside {@link PromptMessageAssembler.buildFinalUserContent} so the envelope
 * format has one owner: change how it is written and this follows. Consumers must not
 * re-derive it from message position — `generateWithTools` appends further user turns
 * after the envelope (tool-result vision injection, the max-round notice), so "the
 * last user message" is not it.
 */
export function isAssembledEnvelope(msg: ChatMessage): boolean {
  if (msg.role !== 'user') return false;
  return contentToPlainString(msg.content ?? '').includes(`<${CURRENT_QUERY_TAG}>`);
}

export interface FinalUserBlocks {
  memoryContext?: string;
  ragContext?: string;
  /**
   * Inline glossary for memes / slang / time-sensitive jargon that may
   * appear in the user's current message. Flat `- term: definition` list.
   * Source is implementation-detail (currently VKB Context Engine); the
   * block name stays vendor-neutral so the LLM treats it as ordinary
   * reference annotation, not a foreign data source.
   */
  glossary?: string;
  /**
   * Volatile persona state — pre-rendered fragment already wrapped in its own
   * `<mind_state>` / `<tone_state>` / `<persona_insight>` / `<relationship_state>`
   * blocks. Lives in the (uncached) final user message rather than the system
   * prompt: it changes every turn, so keeping it out of the system prompt keeps
   * that prefix stable/cacheable, and groups it with the other context blocks
   * instead of stranding it among system rules.
   */
  personaState?: string;
  /**
   * LLM-written per-session memo/blackboard (SessionMemoStore). Short/medium-term
   * items the model chose to carry across turns via the `session_memo` tool.
   * Rendered into a `<session_memo>` block just above `<recent_actions>` so the
   * model sees "what I chose to remember" before "what I just did", both close
   * to the current query.
   */
  sessionMemo?: string;
  /**
   * The bot's own recent actions this session (replied to whom / stayed silent
   * on what), as a short factual list. Lets the model account for what it
   * already did this turn instead of regenerating blind. Rendered into a
   * `<recent_actions>` block just before the current query.
   */
  recentActions?: string;
  currentQuery: string;
}

/**
 * A pre-filled user/assistant turn injected between the system messages
 * and the real conversation history. Used to teach the model a pattern
 * (output format, character voice, tag usage) via role-based few-shot
 * rather than prose examples embedded in the system prompt — which tends
 * to confuse small-to-mid models on where "examples" end and real
 * instructions resume.
 *
 * Only `user` and `assistant` roles are allowed; the assembler rejects
 * anything else at runtime to keep few-shot blocks interleaving cleanly
 * with the trailing history.
 */
export interface FewShotExample {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Deterministic role-based message assembler.
 * Keeps block order and formatting stable for better cache hit rate.
 *
 * Speaker prefixes are attached to user turns only — see {@link buildHistoryEntryPrefix}
 * for why the bot's own turns must not carry one.
 */
export class PromptMessageAssembler {
  buildNormalMessages(params: {
    baseSystem?: string;
    sceneSystem: string;
    fewShotExamples?: FewShotExample[];
    historyEntries: ConversationMessageEntry[];
    finalUserBlocks: FinalUserBlocks;
  }): ChatMessage[] {
    return this.buildMessagesCore(
      params.baseSystem,
      params.sceneSystem,
      params.historyEntries,
      params.finalUserBlocks,
      params.fewShotExamples,
    ).messages;
  }

  /**
   * Like {@link buildNormalMessages}, but also returns each history entry's index
   * in the produced messages array (-1 when the entry serialized to nothing and
   * was skipped). Callers that rewrite history messages in place (e.g. vision
   * ContentPart injection) MUST use this mapping — deriving indices from a fixed
   * system-message count breaks when baseSystem is empty or entries are skipped.
   */
  buildNormalMessagesWithIndex(params: {
    baseSystem?: string;
    sceneSystem: string;
    fewShotExamples?: FewShotExample[];
    historyEntries: ConversationMessageEntry[];
    finalUserBlocks: FinalUserBlocks;
  }): { messages: ChatMessage[]; historyMessageIndices: number[] } {
    return this.buildMessagesCore(
      params.baseSystem,
      params.sceneSystem,
      params.historyEntries,
      params.finalUserBlocks,
      params.fewShotExamples,
    );
  }

  buildProactiveMessages(params: {
    baseSystem?: string;
    sceneSystem: string;
    historyEntries: ConversationMessageEntry[];
    finalUserBlocks: FinalUserBlocks;
  }): ChatMessage[] {
    return this.buildMessagesCore(params.baseSystem, params.sceneSystem, params.historyEntries, params.finalUserBlocks)
      .messages;
  }

  buildTaskAnalyzeMessages(params: {
    baseSystem?: string;
    sceneSystem: string;
    historyEntries: ConversationMessageEntry[];
    currentQuery: string;
  }): ChatMessage[] {
    return this.buildMessagesCore(params.baseSystem, params.sceneSystem, params.historyEntries, {
      currentQuery: params.currentQuery,
    }).messages;
  }

  serializeForFingerprint(messages: ChatMessage[]): string {
    return messages.map((m) => `${m.role}\n${contentToPlainString(m.content)}`).join('\n\n---\n\n');
  }

  private buildMessagesCore(
    baseSystem: string | undefined,
    sceneSystem: string,
    historyEntries: ConversationMessageEntry[],
    finalUserBlocks: FinalUserBlocks,
    fewShotExamples?: FewShotExample[],
  ): { messages: ChatMessage[]; historyMessageIndices: number[] } {
    const messages: ChatMessage[] = [];
    if (baseSystem?.trim()) {
      messages.push({ role: 'system', content: this.normalize(baseSystem) });
    }
    messages.push({ role: 'system', content: this.normalize(sceneSystem) });

    // Few-shot turns live between the system messages and real history.
    // They anchor the model on format/voice before it sees actual dialogue
    // and before the final user block. Kept verbatim (no speaker prefix)
    // because examples represent the target output shape directly.
    if (fewShotExamples?.length) {
      for (const ex of fewShotExamples) {
        const content = this.normalize(ex.content);
        if (!content) continue;
        messages.push({ role: ex.role, content });
      }
    }

    // Entries that serialize to nothing are skipped, so history position i does
    // NOT map to a fixed message offset — record the real index per entry.
    const historyMessageIndices: number[] = [];
    for (const entry of historyEntries) {
      const content = this.serializeEntry(entry);
      if (!content) {
        historyMessageIndices.push(-1);
        continue;
      }
      historyMessageIndices.push(messages.length);
      messages.push({
        role: entry.isBotReply ? 'assistant' : 'user',
        content,
      });
    }

    messages.push({
      role: 'user',
      content: this.buildFinalUserContent(finalUserBlocks),
    });
    return { messages, historyMessageIndices };
  }

  private buildFinalUserContent(blocks: FinalUserBlocks): string {
    const normalize = (v?: string): string => this.normalize(v ?? '');
    const sections: string[] = [];
    if (normalize(blocks.memoryContext)) {
      sections.push(`<memory_context>\n${normalize(blocks.memoryContext)}\n</memory_context>`);
    }
    if (normalize(blocks.ragContext)) {
      sections.push(`<rag_context>\n${normalize(blocks.ragContext)}\n</rag_context>`);
    }
    if (normalize(blocks.glossary)) {
      sections.push(`<glossary>\n${normalize(blocks.glossary)}\n</glossary>`);
    }
    // personaState already carries its own <mind_state>/<tone_state>/... tags.
    if (normalize(blocks.personaState)) {
      sections.push(normalize(blocks.personaState));
    }
    if (normalize(blocks.sessionMemo)) {
      sections.push(`<session_memo>\n${normalize(blocks.sessionMemo)}\n</session_memo>`);
    }
    if (normalize(blocks.recentActions)) {
      sections.push(`<recent_actions>\n${normalize(blocks.recentActions)}\n</recent_actions>`);
    }
    sections.push(`<${CURRENT_QUERY_TAG}>\n${normalize(blocks.currentQuery)}\n</${CURRENT_QUERY_TAG}>`);
    return sections.join('\n\n');
  }

  private serializeEntry(entry: ConversationMessageEntry): string {
    const textFromSegments = this.extractText(entry.segments);
    const text = this.normalize(textFromSegments || entry.content);
    const imageTags = this.extractImageTags(entry.segments, entry.messageId);
    const core = text || imageTags;
    if (!core) return '';
    const prefix = buildHistoryEntryPrefix(entry);
    const lead = prefix ? `${prefix} ` : '';
    return imageTags && text ? `${lead}${text}\n${imageTags}` : `${lead}${core}`;
  }

  private extractText(segments?: MessageSegment[]): string {
    if (!segments?.length) return '';
    const text = segments
      .filter((s): s is MessageSegment & { type: 'text' } => s.type === 'text')
      .map((s) => (s.type === 'text' ? String(s.data.text ?? '') : ''))
      .join('');
    return text.trim();
  }

  private extractImageTags(segments?: MessageSegment[], messageId?: string): string {
    if (!segments?.length) return '';
    const tags: string[] = [];
    let imageIndex = 0;
    for (const segment of segments) {
      if (segment.type !== 'image') continue;
      const id = messageId ? `${messageId}:${imageIndex}` : '';
      const summary = this.normalize(String(segment.data.summary ?? ''));
      tags.push(`<image_segment${id ? ` id="${id}"` : ''} summary="${summary}" />`);
      imageIndex++;
    }
    return tags.join('\n');
  }

  private normalize(value: string): string {
    return value
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .trim();
  }
}
