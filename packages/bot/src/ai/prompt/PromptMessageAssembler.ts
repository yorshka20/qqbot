import type { ChatMessage } from '@/ai/types';
import type { ConversationMessageEntry } from '@/conversation/history';
import type { MessageSegment } from '@/message/types';
import { contentToPlainString } from '../utils/contentUtils';

export interface FinalUserBlocks {
  memoryContext?: string;
  ragContext?: string;
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
    );
  }

  buildProactiveMessages(params: {
    baseSystem?: string;
    sceneSystem: string;
    historyEntries: ConversationMessageEntry[];
    finalUserBlocks: FinalUserBlocks;
  }): ChatMessage[] {
    return this.buildMessagesCore(params.baseSystem, params.sceneSystem, params.historyEntries, params.finalUserBlocks);
  }

  buildTaskAnalyzeMessages(params: {
    baseSystem?: string;
    sceneSystem: string;
    historyEntries: ConversationMessageEntry[];
    currentQuery: string;
  }): ChatMessage[] {
    return this.buildMessagesCore(params.baseSystem, params.sceneSystem, params.historyEntries, {
      currentQuery: params.currentQuery,
    });
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
  ): ChatMessage[] {
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

    for (const entry of historyEntries) {
      const content = this.serializeEntry(entry);
      if (!content) continue;
      messages.push({
        role: entry.isBotReply ? 'assistant' : 'user',
        content,
      });
    }

    messages.push({
      role: 'user',
      content: this.buildFinalUserContent(finalUserBlocks),
    });
    return messages;
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
    sections.push(`<current_query>\n${normalize(blocks.currentQuery)}\n</current_query>`);
    return sections.join('\n\n');
  }

  private serializeEntry(entry: ConversationMessageEntry): string {
    const textFromSegments = this.extractText(entry.segments);
    const text = this.normalize(textFromSegments || entry.content);
    const imageTags = this.extractImageTags(entry.segments, entry.messageId);
    const core = text || imageTags;
    if (!core) return '';
    if (entry.isBotReply) {
      return core;
    }
    const nick = this.normalize(entry.nickname ?? '');
    const prefix = `[speaker:${entry.userId}:${nick}]`;
    return imageTags && text ? `${prefix} ${text}\n${imageTags}` : `${prefix} ${core}`;
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
