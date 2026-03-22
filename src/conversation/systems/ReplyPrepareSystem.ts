// Reply Prepare System - post-process reply before sending
// Handles text cleanup and sendAsForward computation for ALL reply sources.

import { containsTextToolCalls, stripDSML, stripTextToolCalls } from '@/ai/utils/dsmlParser';
import { extractTextFromSegments } from '@/ai/utils/imageUtils';
import { hasReply } from '@/context/HookContextHelpers';
import type { System } from '@/core/system';
import { SystemPriority, SystemStage } from '@/core/system';
import type { HookContext } from '@/hooks/types';
import { MessageUtils } from '@/message/MessageUtils';
import { logger } from '@/utils/logger';

/**
 * Reply Prepare System
 * Runs in the PREPARE stage after PROCESS. Applies uniform post-processing to all replies
 * regardless of source (command, AI, plugin):
 *
 * 1. Text cleanup: strip leaked tool call artifacts (DSML, <tool_call> blocks)
 * 2. sendAsForward resolution: compute once based on final reply segments and group config
 */
export class ReplyPrepareSystem implements System {
  readonly name = 'reply-prepare';
  readonly version = '1.0.0';
  readonly stage = SystemStage.PREPARE;
  readonly priority = SystemPriority.Prepare;

  enabled(): boolean {
    return true;
  }

  async execute(context: HookContext): Promise<boolean> {
    if (!hasReply(context)) {
      return true;
    }

    this.cleanupTextSegments(context);
    this.resolveSendAsForward(context);

    return true;
  }

  /**
   * Strip leaked tool call artifacts from text segments.
   * Safety net for all reply sources — catches anything PROCESS didn't clean.
   */
  private cleanupTextSegments(context: HookContext): void {
    const segments = context.reply!.segments;
    let cleaned = false;

    for (const segment of segments) {
      if (segment.type !== 'text' || !segment.data.text) continue;

      let text = segment.data.text;

      // Strip DSML function call blocks (DeepSeek-specific)
      const afterDsml = stripDSML(text);
      if (afterDsml !== text) {
        text = afterDsml;
        cleaned = true;
      }

      // Strip text-based <tool_call>/<tool_result> blocks
      if (containsTextToolCalls(text)) {
        text = stripTextToolCalls(text);
        cleaned = true;
      }

      if (cleaned) {
        segment.data.text = text;
      }
    }

    if (cleaned) {
      logger.debug('[ReplyPrepareSystem] Cleaned tool call artifacts from text segments');
    }
  }

  /**
   * Compute sendAsForward for the final reply.
   * Explicit values set by commands (via metadata) are respected unless overridden by
   * safety rules (image/record segments can't be forwarded reliably).
   */
  private resolveSendAsForward(context: HookContext): void {
    const reply = context.reply!;
    const segments = reply.segments;

    // Image/record segments can't be forwarded reliably — always send directly
    const hasMedia = segments.some((s) => s.type === 'image' || s.type === 'record');
    if (hasMedia) {
      reply.metadata = { ...reply.metadata, sendAsForward: false };
      return;
    }

    // Commands in forward messages can't be parsed when echoed back — force direct
    const textContent = extractTextFromSegments(segments);
    if (textContent && MessageUtils.isCommand(textContent.trim())) {
      reply.metadata = { ...reply.metadata, sendAsForward: false };
      return;
    }

    // Respect explicit value from command handlers
    const explicitValue = context.metadata.get('explicitSendAsForward');
    if (explicitValue !== undefined) {
      reply.metadata = { ...reply.metadata, sendAsForward: explicitValue };
      return;
    }

    // Fall back to group config
    const groupUseForward = context.metadata.get('groupUseForwardMsg') === true;
    reply.metadata = { ...reply.metadata, sendAsForward: groupUseForward };
  }
}
