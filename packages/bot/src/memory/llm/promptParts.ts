// Prompt fragments shared by the memory prompts (consolidate, review, migrate).

import type { PromptManager } from '@/ai/prompt/PromptManager';
import { GROUP_CORE_SCOPES, USER_CORE_SCOPES } from '@/core/config/types/memory';
import type { MemoryFact } from '@/database/models/types';
import { GROUP_MEMORY_USER_ID } from '../model/constants';
import type { ManualFact } from '../storage/manualFormat';

/** The core scopes the slot may use, their meaning, and the rule/instruction boundary. */
export function scopeGuide(promptManager: PromptManager, userId: string): string {
  if (userId === GROUP_MEMORY_USER_ID) {
    return [
      `群记忆可用：${GROUP_CORE_SCOPES.join(' / ')}`,
      promptManager.render('memory.scopes_group'),
      '`rule` 只属于群记忆，记录 bot 的群级行为设定、群公告、群规。个人的身份、偏好、观点、对 bot 的个人要求不属于群记忆。',
    ].join('\n');
  }
  return [
    `个人记忆可用：${USER_CORE_SCOPES.join(' / ')}`,
    promptManager.render('memory.scopes_user'),
    '个人记忆不能有 `rule`：用户对 bot 的个人要求记为 `instruction`；涉及群规或 bot 群级设定的内容不属于个人记忆。',
  ].join('\n');
}

/** `#n [scope] (durability) content`, numbered from 1 in the order given. */
export function numberFacts(facts: Array<Pick<MemoryFact, 'scope' | 'durability' | 'content'>>): string {
  if (facts.length === 0) {
    return '（无）';
  }
  return facts.map((fact, i) => `#${i + 1} [${fact.scope}] (${fact.durability}) ${fact.content}`).join('\n');
}

export function listManualFacts(facts: ManualFact[]): string {
  return facts.length === 0 ? '（无）' : facts.map((fact) => `- [${fact.scope}] ${fact.content}`).join('\n');
}
