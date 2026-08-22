// Audit event plugin — records the bot's own actions into the per-session
// AuditEventStore, so the next turn's <recent_actions> block can carry a
// factual account of what the bot just did:
//   - reply/silence outcomes at the COMPLETE stage (onMessageComplete)
//   - tool invocations as they execute (onToolExecuted)
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
const GIST_MAX_CHARS = 60;

/** Max chars of a tool's primary string argument kept in a tool summary line. */
const TOOL_ARG_GIST_MAX_CHARS = 60;

/** Tool args whose value best identifies a call, probed in order. */
const TOOL_PRIMARY_ARG_KEYS = ['content', 'task', 'prompt', 'query', 'question', 'name', 'action'] as const;

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
      // The LLM's own first-person take on this turn, emitted as [SUBTEXT: …]
      // and stripped to metadata by PersonaCompletionHookPlugin. Optional — when
      // absent the entry is just the factual action. This is what gives the
      // ledger the bot's reaction/evaluation rather than a monotone action list.
      const reaction = this.reaction(context);
      const ts = Date.now();

      if (reply && reply.trim().length > 0) {
        const action = gist ? `回复了 ${speaker}：「${gist}」` : `回复了 ${speaker}`;
        this.store.record(sessionId, {
          ts,
          kind: 'reply',
          summary: reaction ? `${action} —— ${reaction}` : action,
        });
      } else {
        const action = gist ? `对 ${speaker} 的「${gist}」选择了不回应` : `对 ${speaker} 选择了不回应`;
        this.store.record(sessionId, {
          ts,
          kind: 'silence',
          summary: reaction ? `${action} —— ${reaction}` : action,
        });
      }
    } catch (err) {
      logger.warn('[AuditEventPlugin] record failed (non-fatal):', err);
    }
    return true;
  }

  @Hook({
    stage: 'onToolExecuted',
    priority: 'NORMAL',
    order: 20,
    applicableSources: ['qq-private', 'qq-group', 'discord'],
  })
  async onToolExecuted(context: HookContext): Promise<boolean> {
    if (!this.enabled || !this.store) return true;
    try {
      const call = context.toolCall;
      const result = context.result;
      if (!call || !result || !('reply' in result)) return true;
      // end_turn is loop control, not an action — recording it would be noise.
      if (call.type === 'end_turn') return true;
      // SubAgent-internal tool calls (research fan-out etc.) run on a synthetic
      // context marked with subAgentSessionId; they are implementation detail of
      // one top-level call, not session-level actions.
      if (context.context?.metadata?.get('subAgentSessionId')) return true;
      const sessionId = context.metadata.get('sessionId');
      if (!sessionId) return true;

      const gist = this.toolArgGist(call.parameters);
      const action = gist ? `调用了 ${call.type}（「${gist}」）` : `调用了 ${call.type}`;
      this.store.record(sessionId, {
        ts: Date.now(),
        kind: 'tool',
        summary: result.success ? action : `${action}，失败`,
      });
    } catch (err) {
      logger.warn('[AuditEventPlugin] tool record failed (non-fatal):', err);
    }
    return true;
  }

  private toolArgGist(parameters: Record<string, unknown> | undefined): string {
    if (!parameters) return '';
    for (const key of TOOL_PRIMARY_ARG_KEYS) {
      const v = parameters[key];
      if (typeof v === 'string' && v.trim()) {
        const t = v.trim().replace(/\s+/g, ' ');
        return t.length > TOOL_ARG_GIST_MAX_CHARS ? `${t.slice(0, TOOL_ARG_GIST_MAX_CHARS)}…` : t;
      }
    }
    return '';
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

  private reaction(context: HookContext): string {
    const subtext = context.metadata.get('replySubtext');
    return typeof subtext === 'string' ? subtext.trim() : '';
  }
}
