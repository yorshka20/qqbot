import type { ChatMessage } from '@/ai/types';
import type { ConversationMessageEntry } from '@/conversation/history';
import type { MessageSegment } from '@/message/types';
import { contentToPlainString } from '../utils/contentUtils';

export interface FinalUserBlocks {
  softContext?: string;
  memoryContext?: string;
  ragContext?: string;
  searchResults?: string;
  taskResults?: string;
  currentQuery: string;
}

/**
 * Deterministic role-based message assembler.
 * Keeps block order and formatting stable for better cache hit rate.
 */
export class PromptMessageAssembler {
  buildNormalMessages(params: {
    baseSystem?: string;
    sceneSystem: string;
    historyEntries: ConversationMessageEntry[];
    finalUserBlocks: FinalUserBlocks;
  }): ChatMessage[] {
    return this.buildMessagesCore(params.baseSystem, params.sceneSystem, params.historyEntries, params.finalUserBlocks);
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
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (baseSystem?.trim()) {
      messages.push({ role: 'system', content: this.normalize(baseSystem) });
    }
    messages.push({ role: 'system', content: this.normalize(sceneSystem) });

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
    const sections = [
      `<soft_context>\n${normalize(blocks.softContext)}\n</soft_context>`,
      `<memory_context>\n${normalize(blocks.memoryContext)}\n</memory_context>`,
      `<rag_context>\n${normalize(blocks.ragContext)}\n</rag_context>`,
      `<search_results>\n${normalize(blocks.searchResults)}\n</search_results>`,
      `<task_results>\n${normalize(blocks.taskResults)}\n</task_results>`,
      `<current_query>\n${normalize(blocks.currentQuery)}\n</current_query>`,
    ];
    return sections.join('\n\n');
  }

  private serializeEntry(entry: ConversationMessageEntry): string {
    const textFromSegments = this.extractText(entry.segments);
    const text = this.normalize(textFromSegments || entry.content);
    const imageTags = this.extractImageTags(entry.segments);
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

  private extractImageTags(segments?: MessageSegment[]): string {
    if (!segments?.length) return '';
    const tags: string[] = [];
    for (const segment of segments) {
      if (segment.type !== 'image') continue;
      const uri = this.normalize(String(segment.data.uri ?? segment.data.temp_url ?? segment.data.resource_id ?? ''));
      const summary = this.normalize(String(segment.data.summary ?? ''));
      tags.push(`<image_segment uri="${uri}" summary="${summary}" />`);
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
