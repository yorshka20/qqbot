// Audit event store — the bot's short-term, factual "what I just did" ledger.
//
// Distinct from conversation history (what was *said*, the public transcript)
// and from persona/affect state (how the bot *feels*). This records the bot's
// own typed actions per session — replied to whom, stayed silent on what,
// which tools it invoked — so the next turn's prompt can carry an explicit
// account of recent actions. A stateless LLM regenerates every turn with no
// memory of what it already did; this is the external state that gives it that
// account (e.g. so it can notice "I already answered this" instead of
// re-answering).
//
// In-memory and ephemeral by design: the ledger is a rolling short window
// (minutes), so persisting it across restarts would only carry stale state.
// Retention is time-based ONLY: the window is what defines "recent"; an item
// cap would silently drop actions the LLM still needs (the tokens are cheap,
// the reconstruction reasoning they save is not).

export type AuditEventKind = 'reply' | 'silence' | 'tool';

export interface AuditEvent {
  /** `Date.now()` when the action happened. */
  ts: number;
  kind: AuditEventKind;
  /** Short first-person factual line, e.g. "回复了 张三 的提问". */
  summary: string;
}

export interface AuditEventStoreOptions {
  /** Events older than this (ms) are pruned on read and write. */
  maxAgeMs: number;
}

export const DEFAULT_AUDIT_EVENT_STORE_OPTIONS: AuditEventStoreOptions = {
  maxAgeMs: 45 * 60 * 1000,
};

export class AuditEventStore {
  private readonly bySession = new Map<string, AuditEvent[]>();

  constructor(private readonly options: AuditEventStoreOptions = DEFAULT_AUDIT_EVENT_STORE_OPTIONS) {}

  /** Append one action to a session's ledger, then prune by age + length. */
  record(sessionId: string, event: AuditEvent): void {
    if (!sessionId) return;
    const list = this.bySession.get(sessionId) ?? [];
    list.push(event);
    this.bySession.set(sessionId, this.prune(list, event.ts));
  }

  /** Recent actions for a session, oldest-first, already pruned. */
  getRecent(sessionId: string, now: number = Date.now()): AuditEvent[] {
    const list = this.bySession.get(sessionId);
    if (!list || list.length === 0) return [];
    const pruned = this.prune(list, now);
    this.bySession.set(sessionId, pruned);
    return pruned;
  }

  /**
   * Render a session's recent actions as the inner text of a
   * `<recent_actions>` block. Returns '' when there is nothing to show so the
   * caller can skip the block entirely.
   */
  render(sessionId: string, now: number = Date.now()): string {
    const events = this.getRecent(sessionId, now);
    if (events.length === 0) return '';
    return events.map((e) => `- ${formatClock(e.ts)} ${e.summary}`).join('\n');
  }

  /** Drop events older than maxAgeMs. */
  private prune(list: AuditEvent[], now: number): AuditEvent[] {
    const cutoff = now - this.options.maxAgeMs;
    return list.filter((e) => e.ts >= cutoff);
  }
}

/** Local HH:MM formatter — avoids coupling the store to history formatting utils. */
function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
