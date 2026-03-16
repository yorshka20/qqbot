// AgendaService - manages AgendaItem persistence, scheduling, and dispatch to AgentLoop
//
// Architecture:
//   Cron items   → node-cron ScheduledTask (fires at cron time → agentLoop.run)
//   Once items   → setTimeout (fires once at triggerAt → agentLoop.run)
//   OnEvent items→ InternalEventBus subscription (fires on matching event type)
//
// Cooldown: per-item minimum interval checked before each run (lastRunAt + cooldownMs).
// DB: AgendaItem records are persisted so they survive restarts; schedules are re-hydrated on start.

import cron from 'node-cron';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import { logger } from '@/utils/logger';
import type { AgendaReporter } from './AgendaReporter';
import type { AgentLoop } from './AgentLoop';
import type { InternalEventBus } from './InternalEventBus';
import type { AgendaEventContext, AgendaItem, AgendaSystemEvent, CreateAgendaItemData } from './types';

/** node-cron ScheduledTask interface (minimal, avoids importing full types) */
interface ScheduledTask {
  stop(): void;
}

export class AgendaService {
  /** Running cron tasks keyed by AgendaItem.id */
  private cronTasks = new Map<string, ScheduledTask>();
  /** Running once timers keyed by AgendaItem.id */
  private onceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Bound event handlers keyed by AgendaItem.id (for removal on disable/delete) */
  private eventHandlers = new Map<string, (event: AgendaSystemEvent) => void>();
  /** Config */
  private config: Config;

  constructor(
    private databaseManager: DatabaseManager,
    private agentLoop: AgentLoop,
    private eventBus: InternalEventBus,
    private reporter?: AgendaReporter,
  ) {
    this.config = getContainer().resolve<Config>(DITokens.CONFIG);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Load all enabled items from DB and hydrate their schedules.
   * Call once after DI container is ready.
   */
  async start(): Promise<void> {
    logger.info('[AgendaService] Starting...');
    const items = await this.listItems({ enabledOnly: true });
    for (const item of items) {
      this.scheduleItem(item);
    }
    logger.info(`[AgendaService] Hydrated ${items.length} enabled agenda item(s)`);
  }

  /** Stop all running schedules (for graceful shutdown). */
  stop(): void {
    for (const task of this.cronTasks.values()) {
      task.stop();
    }
    this.cronTasks.clear();

    for (const timer of this.onceTimers.values()) {
      clearTimeout(timer);
    }
    this.onceTimers.clear();

    for (const handler of this.eventHandlers.values()) {
      const eventType = (handler as { _eventType?: string })._eventType;
      if (eventType) {
        this.eventBus.unsubscribe(eventType, handler);
      }
    }
    this.eventHandlers.clear();
    logger.info('[AgendaService] Stopped');
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────────

  /** Create a new AgendaItem and schedule it if enabled. */
  async createItem(data: CreateAgendaItemData): Promise<AgendaItem> {
    const accessor = this.getAccessor();

    const item = await accessor.create({
      ...data,
      cooldownMs: data.cooldownMs ?? 60_000,
      maxSteps: data.maxSteps ?? 15,
      enabled: data.enabled ?? true,
      lastRunAt: undefined,
      nextRunAt: undefined,
      metadata: data.metadata,
    } as Omit<AgendaItem, 'id' | 'createdAt' | 'updatedAt'>);

    if (item.enabled) {
      this.scheduleItem(item);
    }

    logger.info(`[AgendaService] Created item "${item.name}" (${item.id}), trigger: ${item.triggerType}`);
    return item;
  }

  /** Update fields on an existing AgendaItem and reschedule. */
  async updateItem(id: string, data: Partial<Omit<AgendaItem, 'id' | 'createdAt'>>): Promise<AgendaItem> {
    const accessor = this.getAccessor();
    const updated = await accessor.update(id, data);

    // Re-schedule: cancel existing then re-hydrate
    this.cancelSchedule(id);
    if (updated.enabled) {
      this.scheduleItem(updated);
    }

    return updated;
  }

  /** Delete an AgendaItem and cancel its schedule. */
  async deleteItem(id: string): Promise<boolean> {
    this.cancelSchedule(id);
    const accessor = this.getAccessor();
    return accessor.delete(id);
  }

  /** Enable/disable an item. */
  async setEnabled(id: string, enabled: boolean): Promise<AgendaItem> {
    return this.updateItem(id, { enabled });
  }

  /** List agenda items. */
  async listItems(options?: { enabledOnly?: boolean; groupId?: string }): Promise<AgendaItem[]> {
    const accessor = this.getAccessor();
    const criteria: Partial<AgendaItem> = {};
    if (options?.enabledOnly) criteria.enabled = true;
    if (options?.groupId) criteria.groupId = options.groupId;
    return accessor.find(criteria, { orderBy: 'createdAt', order: 'asc' });
  }

  /** Get a single item by ID. */
  async getItem(id: string): Promise<AgendaItem | null> {
    return this.getAccessor().findById(id);
  }

  // ─── Scheduling ──────────────────────────────────────────────────────────────

  /**
   * Attach the appropriate schedule for an item based on triggerType.
   * Idempotent: cancels any existing schedule first.
   */
  private scheduleItem(item: AgendaItem): void {
    this.cancelSchedule(item.id);

    switch (item.triggerType) {
      case 'cron':
        this.scheduleCron(item);
        break;
      case 'once':
        this.scheduleOnce(item);
        break;
      case 'onEvent':
        this.subscribeEvent(item);
        break;
      default:
        logger.warn(`[AgendaService] Unknown triggerType "${item.triggerType}" for item "${item.name}"`);
    }
  }

  private scheduleCron(item: AgendaItem): void {
    if (!item.cronExpr) {
      logger.warn(`[AgendaService] Cron item "${item.name}" has no cronExpr, skipping`);
      return;
    }
    if (!cron.validate(item.cronExpr)) {
      logger.warn(`[AgendaService] Invalid cron expression "${item.cronExpr}" for item "${item.name}", skipping`);
      return;
    }

    const task = cron.schedule(item.cronExpr, async () => {
      await this.fireItem(item, {
        eventType: 'cron',
        groupId: item.groupId,
        userId: item.userId,
        botSelfId: String(this.config.getBotUserId()),
        data: undefined,
      });
    });

    this.cronTasks.set(item.id, task);
    logger.debug(`[AgendaService] Scheduled cron item "${item.name}" @ "${item.cronExpr}"`);
  }

  private scheduleOnce(item: AgendaItem): void {
    if (!item.triggerAt) {
      logger.warn(`[AgendaService] Once item "${item.name}" has no triggerAt, skipping`);
      return;
    }

    const triggerAt = new Date(item.triggerAt).getTime();
    const delay = triggerAt - Date.now();

    if (delay <= 0) {
      logger.debug(`[AgendaService] Once item "${item.name}" triggerAt is in the past; deleting and skipping`);
      if (!item.lastRunAt) {
        void this.deleteItem(item.id);
      }
      return;
    }

    const timer = setTimeout(async () => {
      this.onceTimers.delete(item.id);
      await this.fireItem(item, {
        eventType: 'once',
        groupId: item.groupId,
        userId: item.userId,
        botSelfId: String(this.config.getBotUserId()),
        data: undefined,
      });
    }, delay);

    this.onceTimers.set(item.id, timer);
    logger.debug(`[AgendaService] Scheduled once item "${item.name}" in ${Math.round(delay / 1000)}s`);
  }

  private subscribeEvent(item: AgendaItem): void {
    if (!item.eventType) {
      logger.warn(`[AgendaService] OnEvent item "${item.name}" has no eventType, skipping`);
      return;
    }

    const handler = async (event: AgendaSystemEvent) => {
      // Match groupId filter if item has one
      if (item.groupId && event.groupId && item.groupId !== event.groupId) {
        return;
      }

      // Match eventFilter if present (JSON object of key-value pairs that must be present in event.data)
      if (item.eventFilter) {
        try {
          const filter = JSON.parse(item.eventFilter) as Record<string, unknown>;
          const data = event.data ?? {};
          const matches = Object.entries(filter).every(([k, v]) => data[k] === v);
          if (!matches) return;
        } catch {
          // ignore malformed filter
        }
      }

      const eventContext: AgendaEventContext = {
        eventType: event.type,
        groupId: event.groupId,
        userId: event.userId,
        botSelfId: event.botSelfId,
        data: event.data,
      };
      await this.fireItem(item, eventContext);
    };

    // Tag the handler with eventType so stop() can unsubscribe correctly
    (handler as { _eventType?: string })._eventType = item.eventType;

    this.eventBus.subscribe(item.eventType, handler);
    this.eventHandlers.set(item.id, handler);
    logger.debug(`[AgendaService] Subscribed event item "${item.name}" → "${item.eventType}"`);
  }

  /** Cancel and remove any running schedule for an item. */
  private cancelSchedule(id: string): void {
    const cronTask = this.cronTasks.get(id);
    if (cronTask) {
      cronTask.stop();
      this.cronTasks.delete(id);
    }

    const timer = this.onceTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.onceTimers.delete(id);
    }

    const eventHandler = this.eventHandlers.get(id);
    if (eventHandler) {
      const eventType = (eventHandler as { _eventType?: string })._eventType;
      if (eventType) {
        this.eventBus.unsubscribe(eventType, eventHandler);
      }
      this.eventHandlers.delete(id);
    }
  }

  // ─── Execution ───────────────────────────────────────────────────────────────

  /**
   * Fire an agenda item: check cooldown, run AgentLoop, update lastRunAt.
   */
  private async fireItem(item: AgendaItem, eventContext: AgendaEventContext): Promise<void> {
    // Re-fetch from DB to get latest state (may have been updated/disabled since schedule was set)
    const fresh = await this.getItem(item.id);
    if (!fresh || !fresh.enabled) {
      logger.debug(`[AgendaService] Item "${item.name}" is disabled; skipping`);
      return;
    }

    // Cooldown gate (cron items skip this: the cron expression already controls frequency)
    if (fresh.triggerType !== 'cron' && !this.cooldownPassed(fresh)) {
      logger.debug(`[AgendaService] Item "${fresh.name}" in cooldown; skipping`);
      return;
    }

    logger.info(`[AgendaService] Firing item "${fresh.name}" (${fresh.id})`);
    const startedAt = new Date();
    const startedAtIso = startedAt.toISOString();

    try {
      await this.agentLoop.run(fresh, eventContext);
      await this.reporter?.recordRun({
        item: fresh,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        success: true,
      });
      if (fresh.triggerType === 'once') {
        await this.deleteItem(fresh.id);
      } else {
        await this.getAccessor().update(fresh.id, { lastRunAt: startedAtIso });
      }
    } catch (err) {
      logger.error(`[AgendaService] Item "${fresh.name}" execution failed:`, err);
      // Still update lastRunAt to respect cooldown even on failure (once items remain for retry semantics)
      await this.getAccessor().update(fresh.id, { lastRunAt: startedAtIso });
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.reporter?.recordRun({
        item: fresh,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        success: false,
        error: errMsg,
      });
    }
  }

  /**
   * Returns true if the item's cooldown has passed (or has never run).
   */
  private cooldownPassed(item: AgendaItem): boolean {
    if (!item.lastRunAt) return true;
    const elapsed = Date.now() - new Date(item.lastRunAt).getTime();
    return elapsed >= item.cooldownMs;
  }

  // ─── DB ──────────────────────────────────────────────────────────────────────

  private getAccessor() {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      throw new Error('[AgendaService] Database not connected');
    }
    return adapter.getModel('agendaItems') as import('@/database/models/types').ModelAccessor<AgendaItem>;
  }
}
