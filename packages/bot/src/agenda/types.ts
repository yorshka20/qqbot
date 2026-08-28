// Agenda types: AgendaItem DB model, event bus types, and execution context

import type { MessageSource } from '@/conversation/sources';
import type { BaseModel } from '@/database/models/types';

/** Trigger type for an agenda item */
export type AgendaTriggerType = 'cron' | 'once' | 'onEvent' | 'onMessage';

/**
 * Event type published by MessagePipeline for every processed real-IM message.
 * data: { source: MessageSource, text: string (flattened message), triggeredBot: boolean }.
 * `triggeredBot` is true when the message explicitly addressed the bot (@ / wake word /
 * provider prefix); false for ambient group chatter. PersonaService gates stimulus accrual
 * on this flag; AgendaService onMessage items receive all messages regardless.
 * Consumers: PersonaService (mind stimulus), AgendaService (onMessage items).
 */
export const MESSAGE_RECEIVED_EVENT = 'message_received' as const;

/**
 * AgendaItem - a persistent scheduled intent.
 * Stored in DB; survives restarts.
 * Supports four trigger modes:
 *   - cron:      fires on a cron schedule (e.g. "0 8 * * *")
 *   - once:      fires once at a specific time (triggerAt ISO string)
 *   - onEvent:   fires when an internal system event matches eventType + optional eventFilter
 *   - onMessage: fires when an incoming chat message matches watchKeywords / watchUserId
 */
export interface AgendaItem extends BaseModel {
  /** Human-readable name (e.g. "daily hotspot broadcast") */
  name: string;
  /** Target group ID (required for group actions, empty for private chat) */
  groupId?: string;
  /** Target user ID (for private message actions or schedule creator) */
  userId: string;
  /** Trigger type */
  triggerType: AgendaTriggerType;
  /** Cron expression (for 'cron' trigger, e.g. "0 8 * * *") */
  cronExpr?: string;
  /** ISO date string (for 'once' trigger) */
  triggerAt?: string;
  /** Event type to listen for (for 'onEvent' trigger, e.g. 'group_member_join', 'keyword_match') */
  eventType?: string;
  /** JSON string: additional filter criteria for event matching (e.g. {"keyword":"晚安"}) */
  eventFilter?: string;
  /** JSON string array of keywords (for 'onMessage' trigger; any-of, case-insensitive contains) */
  watchKeywords?: string;
  /** Only messages from this user match (for 'onMessage' trigger) */
  watchUserId?: string;
  /** Natural language description of what the bot should do when triggered */
  intent: string;
  /** Minimum milliseconds between runs (cooldown). Default: 60000 (1 min) */
  cooldownMs: number;
  /** Maximum agent loop steps. Default: 3 */
  maxSteps: number;
  /** Whether this item is enabled */
  enabled: boolean;
  /** ISO string: hard expiry — the item is deleted at this time regardless of fires */
  expiresAt?: string;
  /** Maximum number of fires before the item is deleted. Undefined = unlimited */
  maxFires?: number;
  /** Number of times this item has fired (counts failed runs — a fire consumes budget) */
  fireCount?: number;
  /** ISO string of last successful run */
  lastRunAt?: string;
  /** ISO string of next scheduled run (populated for cron/once, null for onEvent) */
  nextRunAt?: string;
  /** Extra metadata (e.g. provenance: which source created this item) */
  metadata?: Record<string, unknown>;
  /**
   * Execution mode:
   *   - 'intent' (default): LLM interprets the intent text and decides what tools to call
   *   - 'subagent': directly spawn a subagent with the specified preset (bypasses LLM interpretation)
   */
  actionType?: 'intent' | 'subagent' | 'action';
  /** Target for direct execution: subagent presetKey (e.g., 'group_report', 'research') */
  actionTarget?: string;
  /** JSON string of parameters passed to the action (merged into subagent task input) */
  actionParams?: string;
}

/** Data for creating a new AgendaItem (omits auto-managed fields) */
export type CreateAgendaItemData = Omit<AgendaItem, 'id' | 'createdAt' | 'updatedAt'>;

/** Context passed when AgendaItem is triggered by an internal system event */
export interface AgendaEventContext {
  /** The system event type that fired */
  eventType: string;
  /** Group ID from the event (empty for private chat schedules) */
  groupId?: string;
  /** User ID from the event */
  userId: string;
  /** Bot self ID from the event */
  botSelfId: string;
  /** Additional event data */
  data?: Record<string, unknown>;
}

/**
 * Internal system events emitted to InternalEventBus.
 * Any module can publish events; AgendaService subscribes and matches to onEvent items.
 */
export interface AgendaSystemEvent {
  /** Event type string. Reserved: 'group_member_join', 'keyword_match', 'group_nudge' */
  type: string;
  groupId: string;
  userId: string;
  botSelfId: string;
  data?: {
    source?: MessageSource;
    text?: string;
    /** if already triggered a bot reply */
    triggeredBot?: boolean;

    [key: string]: unknown;
  };
}

/**
 * Request to create an agenda item on behalf of the LLM (schedule_task / watch_messages tools).
 * All limits are enforced server-side by AgendaService.createLlmItem — LLM-supplied
 * values are clamped or rejected, never trusted.
 */
export interface LlmAgendaRequest {
  kind: 'once' | 'onMessage';
  /** The prompt the LLM wrote for its future self; stored as the item's intent */
  prompt: string;
  /** Optional human-readable name */
  name?: string;
  /** Conversation scope (from tool execution context, never LLM-supplied) */
  groupId?: string;
  userId: string;
  /** For kind='once': when to fire (ISO) */
  triggerAt?: string;
  /** For kind='onMessage': keywords to match (any-of, contains) */
  keywords?: string[];
  /** For kind='onMessage': only messages from this user match */
  watchUserId?: string;
  /** For kind='onMessage': TTL in ms (clamped to limits) */
  ttlMs?: number;
  /** For kind='onMessage': fire budget (clamped to limits) */
  maxFires?: number;
  /** Self-scheduling chain depth: 0 for reply-pipeline calls, parent+1 for agenda-run calls */
  chainDepth: number;
}

/** Result of AgendaService.createLlmItem: either the created item or an LLM-readable rejection */
export type LlmAgendaResult = { ok: true; item: AgendaItem } | { ok: false; error: string };
