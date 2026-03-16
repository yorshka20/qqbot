// Agenda types: AgendaItem DB model, event bus types, and execution context

import type { BaseModel } from '@/database/models/types';

/** Trigger type for an agenda item */
export type AgendaTriggerType = 'cron' | 'once' | 'onEvent';

/**
 * AgendaItem - a persistent scheduled intent.
 * Stored in DB; survives restarts.
 * Supports three trigger modes:
 *   - cron:    fires on a cron schedule (e.g. "0 8 * * *")
 *   - once:    fires once at a specific time (triggerAt ISO string)
 *   - onEvent: fires when an internal system event matches eventType + optional eventFilter
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
  /** Natural language description of what the bot should do when triggered */
  intent: string;
  /** Minimum milliseconds between runs (cooldown). Default: 60000 (1 min) */
  cooldownMs: number;
  /** Maximum agent loop steps. Default: 3 */
  maxSteps: number;
  /** Whether this item is enabled */
  enabled: boolean;
  /** ISO string of last successful run */
  lastRunAt?: string;
  /** ISO string of next scheduled run (populated for cron/once, null for onEvent) */
  nextRunAt?: string;
  /** JSON string for extra metadata */
  metadata?: string;
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
  data?: Record<string, unknown>;
}
