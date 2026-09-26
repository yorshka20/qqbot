// Which scopes a memory slot may hold, and how a prompt describes them.

import type { PromptManager } from '@/ai/prompt/PromptManager';
import { GROUP_CORE_SCOPES, USER_CORE_SCOPES } from '@/core/config/types/memory';
import { coreScopeOf } from './manualMemory';
import { GROUP_MEMORY_USER_ID } from './memoryConstants';

export function allowedCoreScopes(userId: string): readonly string[] {
  return userId === GROUP_MEMORY_USER_ID ? GROUP_CORE_SCOPES : USER_CORE_SCOPES;
}

export function isAllowedScope(userId: string, scope: string): boolean {
  return /^[a-z_]+(:[a-z0-9_]+)?$/.test(scope) && allowedCoreScopes(userId).includes(coreScopeOf(scope));
}

export function slotLabel(userId: string): string {
  return userId === GROUP_MEMORY_USER_ID ? '本群的群记忆' : `群成员 ${userId} 的个人记忆`;
}

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
