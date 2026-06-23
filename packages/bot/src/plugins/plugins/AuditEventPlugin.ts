// Audit event plugin — records the bot's own actions into the per-session
// AuditEventStore at the COMPLETE stage, so the next turn's <recent_actions>
// block can carry a factual account of what the bot just did.
//
// Records are derived from the real pipeline outcome (a reply was produced, or
// the bot was addressed but stayed silent) — never from LLM self-report — which
// is what makes the ledger trustworthy for "did I already answer this?".

import { getReply } from '@/context/HookContextHelpers';
import type { AuditEventStore } from '@/conversation/audit/AuditEventStore';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { Hook, RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

/** Max chars of the triggering user message folded into a summary line. */
const GIST_MAX_CHARS = 16;

@RegisterPlugin({
  name: 'audit-event',
  version: '1.0.0',
  description: "Records the bot's reply/silence actions into the per-session audit ledger",
})
export class AuditEventPlugin extends PluginBase {
  private store: AuditEventStore | null = null;

  async onInit(): Promise<void> {
    // AUDIT_EVENT_STORE is required (DITokens.ts) — registered by bootstrap.
    this.store = getContainer().resolve<AuditEventStore>(DITokens.AUDIT_EVENT_STORE);
  }

  @Hook({
    stage: 'onMessageComplete',
    priority: 'NORMAL',
    order: 20,
    // IM conversations only — synthetic sources carry sentinel ids and don't
    // form a session ledger worth replaying.
    applicableSources: ['qq-private', 'qq-group', 'discord'],
  })
  async onMessageComplete(context: HookContext): Promise<boolean> {
    if (!this.enabled || !this.store) return true;
    try {
      const sessionId = context.metadata.get('sessionId');
      if (!sessionId) return true;

      const reply = getReply(context);
      const addressed = !!context.metadata.get('replyTriggerType');
      // Skip turns the bot was never part of (ambient chatter, no reply): nothing
      // the bot "did", so nothing to record.
      if (!reply && !addressed) return true;

      const speaker = this.speakerLabel(context);
      const gist = this.gist(context);
      const ts = Date.now();

      if (reply && reply.trim().length > 0) {
        this.store.record(sessionId, {
          ts,
          kind: 'reply',
          summary: gist ? `回复了 ${speaker}：「${gist}」` : `回复了 ${speaker}`,
        });
      } else {
        this.store.record(sessionId, {
          ts,
          kind: 'silence',
          summary: gist ? `对 ${speaker} 的「${gist}」选择了不回应` : `对 ${speaker} 选择了不回应`,
        });
      }
    } catch (err) {
      logger.warn('[AuditEventPlugin] record failed (non-fatal):', err);
    }
    return true;
  }

  private speakerLabel(context: HookContext): string {
    const sender = context.message?.sender;
    const nick = sender?.nickname ?? sender?.card ?? '';
    if (nick) return nick;
    const userId = context.message?.userId;
    return userId != null ? String(userId) : '某人';
  }

  private gist(context: HookContext): string {
    const text = (context.message?.message ?? context.message?.rawMessage ?? '').trim();
    if (!text) return '';
    return text.length > GIST_MAX_CHARS ? `${text.slice(0, GIST_MAX_CHARS)}…` : text;
  }
}
