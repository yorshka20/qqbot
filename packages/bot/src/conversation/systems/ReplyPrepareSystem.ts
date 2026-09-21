// Reply Prepare System - post-process reply before sending
// Handles text cleanup and sendAsForward computation for ALL reply sources.

import { containsTextToolCalls, stripDSML, stripTextToolCalls } from '@/ai/utils/dsmlParser';
import { extractTextFromSegments } from '@/ai/utils/imageUtils';
import { hasReply } from '@/context/HookContextHelpers';
import type { System } from '@/core/system';
import { SystemPriority, SystemStage } from '@/core/system';
import type { HookContext } from '@/hooks/types';
import { MessageUtils } from '@/message/MessageUtils';
import { expandFaceMarkers } from '@/message/qqFace';
import type { MessageSegment } from '@/message/types';
import { getProtocolAdapter, isProtocolRegistered } from '@/protocol/ProtocolRegistry';
import { logger } from '@/utils/logger';

/**
 * Reply Prepare System
 * Runs in the PREPARE stage after PROCESS. Applies uniform post-processing to all replies
 * regardless of source (command, AI, plugin):
 *
 * 1. Text cleanup: strip leaked tool call artifacts (DSML, <tool_call> blocks) and expand
 *    `[表情:名字]` markers into face segments
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
   * Strip leaked tool call artifacts from text segments, then expand `[表情:名字]` markers
   * into face segments.
   *
   * Both are text-level rewrites every reply source needs, which is why they run here rather
   * than on the AI path: a command or plugin reply carrying a marker has to expand too, or the
   * token reaches the chat as literal text.
   */
  private cleanupTextSegments(context: HookContext): void {
    // biome-ignore lint/style/noNonNullAssertion: cleanupTextSegments is only called when reply is set by upstream system
    const reply = context.reply!;
    const rebuilt: MessageSegment[] = [];
    const unresolvedFaces: string[] = [];
    let cleaned = false;
    let expandedFaces = 0;

    for (const segment of reply.segments) {
      if (segment.type !== 'text' || !segment.data.text) {
        rebuilt.push(segment);
        continue;
      }

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

      const { segments: expanded, unresolved } = expandFaceMarkers(text);
      unresolvedFaces.push(...unresolved);
      expandedFaces += expanded.filter((s) => s.type === 'face').length;
      rebuilt.push(...expanded);
    }

    reply.segments = rebuilt;

    if (cleaned) {
      logger.debug('[ReplyPrepareSystem] Cleaned tool call artifacts from text segments');
    }
    if (expandedFaces > 0) {
      logger.debug(`[ReplyPrepareSystem] Expanded ${expandedFaces} face marker(s) into face segments`);
    }
    if (unresolvedFaces.length > 0) {
      logger.warn(
        `[ReplyPrepareSystem] Dropped unknown face marker(s): ${unresolvedFaces.join(', ')} — add them to the face table or the prompt vocabulary`,
      );
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

    // Only protocols that support forward messages can use sendAsForward.
    // Synthetic protocols (e.g. `lan-dispatch` used by LanRelayClient) are not
    // registered here — they route through LAN relay to the host, which owns
    // the real adapter. SendSystem assumes supportsForwardMessage=true for
    // unregistered protocols; we mirror that to keep behavior consistent.
    if (isProtocolRegistered(context.message.protocol)) {
      const adapter = getProtocolAdapter(context.message.protocol);
      if (!adapter.supportsForwardMessage()) {
        reply.metadata = { ...reply.metadata, sendAsForward: false };
        return;
      }
    }

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
