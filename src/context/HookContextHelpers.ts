// HookContext helper functions
// Provides type-safe operations on HookContext fields (reply, etc.)

import { extractTextFromSegments } from '@/ai/utils/imageUtils';
import type { HookContext, ReplyContent, ReplyMetadata } from '@/hooks/types';
import type { MessageSegment } from '@/message/types';

/**
 * Set reply content in HookContext (for plain text messages)
 * Converts text to text segment automatically
 *
 * @param context - Hook context
 * @param text - Reply message text
 * @param source - Source of the reply (command, task, plugin, or ai)
 * @param metadata - Optional reply metadata (flags only)
 */
export function setReply(
  context: HookContext,
  text: string,
  source: ReplyContent['source'],
  metadata?: ReplyMetadata,
): void {
  context.reply = {
    source,
    segments: [
      {
        type: 'text',
        data: { text },
      },
    ],
    ...(metadata && { metadata }),
  };
}

/**
 * Set reply content with message segments in HookContext
 *
 * @param context - Hook context
 * @param segments - Message segments (images, audio, etc.)
 * @param source - Source of the reply (command, task, plugin, or ai)
 * @param metadata - Optional reply metadata (flags only)
 */
export function setReplyWithSegments(
  context: HookContext,
  segments: MessageSegment[],
  source: ReplyContent['source'],
  metadata?: ReplyMetadata,
): void {
  context.reply = {
    source,
    segments, // Set at top level, not in metadata
    ...(metadata && { metadata }),
  };
}

/**
 * Get reply text from HookContext (extracts text from segments)
 *
 * @param context - Hook context
 * @returns Reply text or undefined if no reply exists
 */
export function getReply(context: HookContext): string | undefined {
  if (!context.reply?.segments) {
    return undefined;
  }
  return extractTextFromSegments(context.reply.segments);
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
  return !!(context.reply?.segments && context.reply.segments.length > 0);
}

/**
 * Clear reply from HookContext
 *
 * @param context - Hook context
 */
export function clearReply(context: HookContext): void {
  context.reply = undefined;
}
