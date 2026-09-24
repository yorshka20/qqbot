// Shared user-message prefix for the report call and the comic call.
//
// DeepSeek's prefix cache hits only when the bytes from the start of the
// request match. Both calls therefore use the same system prompt, and this
// prefix (stats + yesterday's log) is the start of both user messages.
// The task text is appended after it.

import type { PromptManager } from '@/ai/prompt/PromptManager';

const CONTEXT_TEMPLATE = 'subagent.group_report.context';

export interface GroupChatPrefixVars {
  groupName: string;
  date: string;
  totalMessages: string;
  activeMembers: string;
  highlightTimeRange: string;
  hourlyActivityJson: string;
  memberStats: string;
  chatHistory: string;
}

/** Stats and chat log, with no task instruction. */
export function renderGroupChatPrefix(promptManager: PromptManager, vars: GroupChatPrefixVars): string {
  const variables: Record<string, string> = { ...vars };
  return promptManager.render(CONTEXT_TEMPLATE, variables).trimEnd();
}

/** Prefix, then the task. The task is the only part that may differ between calls. */
export function withTaskSuffix(prefix: string, task: string): string {
  return `${prefix}\n\n${task.trim()}`;
}
