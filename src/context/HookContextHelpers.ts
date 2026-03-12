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
 * Resolve whether this reply should be sent as forward (Milky). Call this when setting reply upstream.
 * When explicitValue is set (e.g. from command result), it wins; otherwise group config + segment types decide
 * (image/record cannot be forwarded reliably).
 */
export function computeSendAsForward(
  context: HookContext,
  segments: MessageSegment[],
  explicitValue?: boolean,
): boolean {
  if (explicitValue !== undefined) return explicitValue;
  const groupUseForward = context.metadata.get('groupUseForwardMsg') === true;
  const hasImage = segments.some((s) => s.type === 'image');
  const hasRecord = segments.some((s) => s.type === 'record');
  return groupUseForward && !hasImage && !hasRecord;
}

/**
 * Get reply text from HookContext (for persistence/history: prefers card text when reply is card image)
 * When reply is a card image, returns the stored card text so history/context/cache store text, not image.
 *
 * @param context - Hook context
 * @returns Reply text or undefined if no reply exists
 */
export function getReply(context: HookContext): string | undefined {
  if (!context.reply) {
    return undefined;
  }
  // Card reply: prefer stored card text (even if segments were missing) so we never lose card text
  if (context.reply.metadata?.cardTextForHistory != null && context.reply.metadata.cardTextForHistory !== '') {
    return context.reply.metadata.cardTextForHistory;
  }
  if (!context.reply.segments || context.reply.segments.length === 0) {
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

/**
 * True when the pipeline must not produce a direct reply: either access denied (whitelistDenied) or no direct reply path (postProcessOnly).
 * Use for reply-related plugins (Echo, ReplySystem, etc.). Proactive uses only whitelistDenied.
 */
export function isNoReplyPath(context: HookContext): boolean {
  return !!(context.metadata.get('postProcessOnly') || context.metadata.get('whitelistDenied'));
}

/**
 * True when the context's group/user is allowed and has the given whitelist capability.
 * Use when a group has limited permissions (whitelistGroupCapabilities set): only listed capabilities are allowed.
 * - If whitelistDenied: always false.
 * - If whitelistGroupCapabilities is unset or empty: full access, always true.
 * - Otherwise: true only when capability is in whitelistGroupCapabilities.
 */
export function hasWhitelistCapability(context: HookContext, capability: string): boolean {
  if (context.metadata.get('whitelistDenied')) {
    return false;
  }
  const caps = context.metadata.get('whitelistGroupCapabilities');
  if (!caps || caps.length === 0) {
    return true;
  }
  return caps.includes(capability);
}
