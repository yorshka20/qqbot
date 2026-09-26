// Scope rules: `core_scope` or `core_scope:subtag`, and which cores each slot may hold.

import { GROUP_CORE_SCOPES, USER_CORE_SCOPES } from '@/core/config/types/memory';
import { GROUP_MEMORY_USER_ID } from './constants';

export function coreScopeOf(scope: string): string {
  const index = scope.indexOf(':');
  return index === -1 ? scope : scope.slice(0, index);
}

export function allowedCoreScopes(userId: string): readonly string[] {
  return userId === GROUP_MEMORY_USER_ID ? GROUP_CORE_SCOPES : USER_CORE_SCOPES;
}

export function isAllowedScope(userId: string, scope: string): boolean {
  return /^[a-z_]+(:[a-z0-9_]+)?$/.test(scope) && allowedCoreScopes(userId).includes(coreScopeOf(scope));
}

export function slotLabel(userId: string): string {
  return userId === GROUP_MEMORY_USER_ID ? '本群的群记忆' : `群成员 ${userId} 的个人记忆`;
}
