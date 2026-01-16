// HookContext helper functions
// Provides type-safe operations on HookContext fields (reply, etc.)

import type { HookContext, ReplyContent } from '@/hooks/types';

/**
 * Set reply content in HookContext
 *
 * @param context - Hook context
 * @param text - Reply message text
 * @param source - Source of the reply (command, task, plugin, or ai)
 * @param metadata - Optional reply metadata (images, formatting, etc.)
 */
export function setReply(
  context: HookContext,
  text: string,
  source: ReplyContent['source'],
  metadata?: ReplyContent['metadata'],
): void {
  context.reply = {
    text,
    source,
    ...(metadata && { metadata }),
  };
}

/**
 * Get reply text from HookContext
 *
 * @param context - Hook context
 * @returns Reply text or undefined if no reply exists
 */
export function getReply(context: HookContext): string | undefined {
  return context.reply?.text;
}

/**
 * Get full reply content from HookContext
 *
 * @param context - Hook context
 * @returns Full reply content or undefined if no reply exists
 */
export function getReplyContent(context: HookContext): ReplyContent | undefined {
  return context.reply;
}

/**
 * Check if reply exists in HookContext
 *
 * @param context - Hook context
 * @returns True if reply exists, false otherwise
 */
export function hasReply(context: HookContext): boolean {
  return !!context.reply?.text;
}

/**
 * Clear reply from HookContext
 *
 * @param context - Hook context
 */
export function clearReply(context: HookContext): void {
  context.reply = undefined;
}
