// HookContext helper functions
// Provides type-safe operations on HookContext fields (reply, etc.)

import { extractTextFromSegments } from '@/ai/utils/imageUtils';
import type { HookContext, ReplyContent, ReplyMetadata } from '@/hooks/types';
import type { MessageSegment } from '@/message/types';

/**
 * Append reply content to HookContext (for plain text messages)
 * Converts text to text segment automatically and appends to existing reply
 * If no existing reply, creates a new one
 *
 * @param context - Hook context
 * @param text - Reply message text
 * @param source - Source of the reply (command, task, plugin, or ai)
 * @param metadata - Optional reply metadata (flags only, will be merged with existing)
 */
export function setReply(
  context: HookContext,
  text: string,
  source: ReplyContent['source'],
  metadata?: ReplyMetadata,
): void {
  const newSegment: MessageSegment = {
    type: 'text',
    data: { text },
  };

  if (context.reply?.segments) {
    // Append to existing reply
    context.reply.segments.push(newSegment);
    // Merge metadata (new metadata overrides existing)
    if (metadata) {
      context.reply.metadata = {
        ...context.reply.metadata,
        ...metadata,
      };
    }
    // Update source to the latest one (most recent source)
    context.reply.source = source;
  } else {
    // Create new reply
    context.reply = {
      source,
      segments: [newSegment],
      ...(metadata && { metadata }),
    };
  }
}

/**
 * Append reply content with message segments to HookContext
 * Appends segments to existing reply if it exists
 *
 * @param context - Hook context
 * @param segments - Message segments (images, audio, etc.)
 * @param source - Source of the reply (command, task, plugin, or ai)
 * @param metadata - Optional reply metadata (flags only, will be merged with existing)
 */
export function setReplyWithSegments(
  context: HookContext,
  segments: MessageSegment[],
  source: ReplyContent['source'],
  metadata?: ReplyMetadata,
): void {
  if (context.reply?.segments) {
    // Append to existing reply
    context.reply.segments.push(...segments);
    // Merge metadata (new metadata overrides existing)
    if (metadata) {
      context.reply.metadata = {
        ...context.reply.metadata,
        ...metadata,
      };
    }
    // Update source to the latest one (most recent source)
    context.reply.source = source;
  } else {
    // Create new reply
    context.reply = {
      source,
      segments,
      ...(metadata && { metadata }),
    };
  }
}

/**
 * Replace reply content in HookContext (for plain text messages)
 * Replaces existing reply completely, or creates new if none exists
 * Use this when you need to explicitly replace the reply (e.g., fallback scenarios)
 *
 * @param context - Hook context
 * @param text - Reply message text
 * @param source - Source of the reply (command, task, plugin, or ai)
 * @param metadata - Optional reply metadata (flags only)
 */
export function replaceReply(
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
 * Replace reply content with message segments in HookContext
 * Replaces existing reply completely, or creates new if none exists
 * Use this when you need to explicitly replace the reply (e.g., command results, plugin results)
 *
 * @param context - Hook context
 * @param segments - Message segments (images, audio, etc.)
 * @param source - Source of the reply (command, task, plugin, or ai)
 * @param metadata - Optional reply metadata (flags only)
 */
export function replaceReplyWithSegments(
  context: HookContext,
  segments: MessageSegment[],
  source: ReplyContent['source'],
  metadata?: ReplyMetadata,
): void {
  context.reply = {
    source,
    segments,
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
