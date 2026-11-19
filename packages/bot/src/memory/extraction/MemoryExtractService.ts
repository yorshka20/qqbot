// Memory extraction: the prompt that asks a model for candidate facts in a chat log, and the
// reading of its answer into candidates per slot. The call itself runs as a batch job
// (memory/batch); consolidation folds the candidates into stored memory.

import { logger } from '@qqbot/shared';
import { inject, singleton } from 'tsyringe';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { GROUP_CORE_SCOPES, USER_CORE_SCOPES } from '@/core/config/types/memory';
import { DITokens } from '@/core/DITokens';
import { parseMemoryJson } from '../llm/memoryLLM';
import { GROUP_MEMORY_USER_ID } from '../model/constants';

/** A candidate fact as consolidation reads it: "[scope] content", or the bare content without a scope. */
export function formatCandidate(content: string, scope?: string): string {
  const trimmedScope = scope?.trim();
  return trimmedScope ? `[${trimmedScope}] ${content.trim()}` : content.trim();
}

@singleton()
export class MemoryExtractService {
  constructor(@inject(DITokens.PROMPT_MANAGER) private promptManager: PromptManager) {}

  /**
   * The extraction prompt for a chat log. With `focusUserId` the model is pointed at that one
   * member, and {@link parseExtractOutput} keeps only that member's facts.
   */
  renderExtractRequest(groupId: string, chatLog: string, focusUserId?: string): { system?: string; prompt: string } {
    const prompt = this.promptManager.render('memory.extract', {
      groupId,
      recentMessagesText: chatLog || '(no messages)',
      targetUserSection: focusUserId
        ? this.promptManager.render('memory.extract_single_user', { targetUserId: focusUserId })
        : '',
      ...this.getScopeTemplateVars(),
    });
    if (!focusUserId) {
      return { prompt };
    }
    return { system: this.promptManager.renderBasePrompt({ introspection: false }), prompt };
  }

  /**
   * Task suffix for extraction appended to a shared chat-log prefix (the group_day fan-out):
   * the same rules as memory.extract, without its own copy of the messages.
   */
  renderPrefixedExtractTask(): string {
    return this.promptManager.render('fanout.group_day.tasks.memory', this.getScopeTemplateVars());
  }

  /**
   * Candidates per slot (GROUP_MEMORY_USER_ID for the group's own memory) from an extraction
   * answer, or null when the answer cannot be read. `focusUserId` keeps only that member's slot.
   * Facts come as `{ scope, content }` or as plain strings.
   */
  parseExtractOutput(text: string, focusUserId?: string): Map<string, string[]> | null {
    const obj = parseMemoryJson(text, 'MemoryExtract');
    if (!obj) {
      return null;
    }
    const slots = new Map<string, string[]>();
    const push = (userId: string, facts: string[]) => {
      if (facts.length > 0) {
        slots.set(userId, [...(slots.get(userId) ?? []), ...facts]);
      }
    };
    if (!focusUserId && Array.isArray(obj.group_facts)) {
      push(GROUP_MEMORY_USER_ID, this.normalizeFacts(obj.group_facts));
    }
    if (Array.isArray(obj.user_facts)) {
      for (const item of obj.user_facts) {
        const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
        const userId =
          typeof row.user_id === 'string' || typeof row.user_id === 'number' ? String(row.user_id).trim() : '';
        if (!userId || !Array.isArray(row.facts) || (focusUserId && userId !== focusUserId)) {
          continue;
        }
        push(userId, this.normalizeFacts(row.facts));
      }
    }
    logger.debug(`[MemoryExtractService] extract output slots=[${[...slots.keys()].join(',')}]`);
    return slots;
  }

  private normalizeFacts(raw: unknown[]): string[] {
    return raw.map((f) => this.normalizeFact(f)).filter((s): s is string => s != null);
  }

  private normalizeFact(f: unknown): string | null {
    if (typeof f === 'string') {
      return f.trim() || null;
    }
    if (f && typeof f === 'object' && 'content' in f) {
      const o = f as Record<string, unknown>;
      const content = typeof o.content === 'string' ? o.content.trim() : '';
      if (!content) {
        return null;
      }
      return formatCandidate(content, typeof o.scope === 'string' ? o.scope : undefined);
    }
    return null;
  }

  private getScopeTemplateVars(): Record<string, string> {
    return {
      userCoreScopes: USER_CORE_SCOPES.join(' / '),
      groupCoreScopes: GROUP_CORE_SCOPES.join(' / '),
      userScopeDescriptions: this.promptManager.render('memory.scopes_user'),
      groupScopeDescriptions: this.promptManager.render('memory.scopes_group'),
    };
  }
}
