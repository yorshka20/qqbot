// Reaction Plugin - owns every reaction ("贴表情") the bot puts on a group message.

import type { NormalizedMessageEvent } from '@/events/types';
import { reactionLabel, resolveReactionId } from '@/message/qqFace';
import type { NormalizedMilkyMessageEvent } from '@/protocol/milky/types';
import { logger } from '@/utils/logger';
import { groupHasWhitelistCapability, WHITELIST_CAPABILITY } from '@/utils/whitelistCapabilities';
import { RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

interface ReactionPluginConfig {
  /** Minimum gap between two reactions in the same group. Default: 60s. */
  minIntervalMsPerGroup?: number;
}

const DEFAULT_MIN_INTERVAL_MS = 60_000;

export interface ReactionRequest {
  groupId: number | string;
  /** Milky addresses a message by its per-group sequence number, not by message id. */
  messageSeq: number;
  /** Face name (`笑哭`), `#<id>` escape, literal emoji (`👍`), or a raw id. */
  face: string;
}

export type ReactionOutcome = { ok: true; faceId: string; label: string } | { ok: false; reason: string };

/**
 * Reaction Plugin
 *
 * This is the single place a reaction is sent from, so the whitelist capability and the
 * per-group rate limit are enforced once, whatever asked for the reaction (the `react` tool
 * during a reply, the proactive analysis between replies).
 *
 * It deliberately registers no message hook. Reactions used to fire from a keyword table at
 * PREPROCESS, which matched the *name* of an emotion ("笑哭", "可爱") rather than the emotion
 * — over 8 days it fired 7 times, several of them on unrelated words, while group members sent
 * 826 faces the bot could not read. Choosing a reaction is a judgement about what was said,
 * so the model makes it.
 */
@RegisterPlugin({
  name: 'reaction',
  version: '2.0.0',
  description: 'Sends group message reactions on behalf of the LLM',
})
export class ReactionPlugin extends PluginBase {
  private minIntervalMs = DEFAULT_MIN_INTERVAL_MS;
  private lastReactionAtByGroup = new Map<string, number>();

  async onInit(): Promise<void> {
    const pluginConfig = this.pluginConfig?.config as ReactionPluginConfig | undefined;
    if (pluginConfig?.minIntervalMsPerGroup != null && pluginConfig.minIntervalMsPerGroup >= 0) {
      this.minIntervalMs = pluginConfig.minIntervalMsPerGroup;
    }
  }

  /**
   * Resolve the message sequence a reaction can target.
   *
   * Only Milky carries one; on other protocols a reaction cannot be addressed at all, which is
   * why callers check this before offering the action rather than failing after the fact.
   */
  static messageSeqOf(message: NormalizedMessageEvent): number | undefined {
    const seq = (message as NormalizedMilkyMessageEvent).messageSeq;
    return typeof seq === 'number' && seq > 0 ? seq : undefined;
  }

  /** Send one reaction. Returns why it was refused instead of throwing, so callers can tell the model. */
  async react(request: ReactionRequest): Promise<ReactionOutcome> {
    if (!this.enabled) {
      return { ok: false, reason: 'reaction plugin disabled' };
    }

    const groupId = String(request.groupId);
    if (!groupId || !request.messageSeq) {
      return { ok: false, reason: 'missing groupId or messageSeq' };
    }

    if (!groupHasWhitelistCapability(groupId, WHITELIST_CAPABILITY.reaction)) {
      return { ok: false, reason: 'group not allowed to receive reactions' };
    }

    const faceId = resolveReactionId(request.face);
    if (!faceId) {
      return { ok: false, reason: `unknown face "${request.face}"` };
    }

    const now = Date.now();
    const last = this.lastReactionAtByGroup.get(groupId);
    if (last !== undefined && now - last < this.minIntervalMs) {
      const waitSec = Math.ceil((this.minIntervalMs - (now - last)) / 1000);
      return { ok: false, reason: `rate limited, ${waitSec}s until the next reaction in this group` };
    }

    const label = reactionLabel(faceId);
    try {
      await this.api.call(
        'send_group_message_reaction',
        { group_id: Number(groupId), message_seq: request.messageSeq, reaction: faceId, is_add: true },
        'milky',
      );
    } catch (error) {
      logger.error(`[ReactionPlugin] Send failed | groupId=${groupId} | messageSeq=${request.messageSeq}:`, error);
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }

    // Recorded only after a successful send, so a failed attempt does not spend the window.
    this.lastReactionAtByGroup.set(groupId, now);
    logger.info(
      `[ReactionPlugin] Reacted | groupId=${groupId} | messageSeq=${request.messageSeq} | face=${label} (${faceId})`,
    );
    return { ok: true, faceId, label };
  }
}
