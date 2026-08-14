// AgendaService - manages AgendaItem persistence, scheduling, and dispatch to AgentLoop
//
// Architecture:
//   Cron items     → node-cron ScheduledTask (fires at cron time → agentLoop.run)
//   Once items     → setTimeout (fires once at triggerAt → agentLoop.run)
//   OnEvent items  → InternalEventBus subscription (fires on matching event type)
//   OnMessage items→ InternalEventBus subscription to MESSAGE_RECEIVED_EVENT
//                    (fires when watchKeywords / watchUserId match an incoming message)
//
// Lifecycle: items may carry expiresAt (hard TTL, deleted at expiry) and maxFires
// (fire budget, deleted once exhausted; failed runs also consume budget).
// Cooldown: per-item minimum interval checked before each run (lastRunAt + cooldownMs).
// DB: AgendaItem records are persisted so they survive restarts; schedules are re-hydrated on start.

import cron from 'node-cron';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { PluginManager } from '@/plugins/PluginManager';
import { logger } from '@/utils/logger';
import type { ActionHandlerRegistry } from './ActionHandlerRegistry';
import type { AgendaReporter } from './AgendaReporter';
import type { AgentLoop } from './AgentLoop';
import type { InternalEventBus } from './InternalEventBus';
import { matchOnMessageEvent, parseWatchKeywords } from './onMessageMatch';
import {
  type AgendaEventContext,
  type AgendaItem,
  type AgendaSystemEvent,
  type CreateAgendaItemData,
  type LlmAgendaRequest,
  type LlmAgendaResult,
  MESSAGE_RECEIVED_EVENT,
} from './types';

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
  /** Expiry timers keyed by AgendaItem.id (items with expiresAt) */
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Config */
  private config: Config;
  /** Periodic cron re-hydration timer (guards against node-cron silently dropping tasks) */
  private rehydrateTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private databaseManager: DatabaseManager,
    private agentLoop: AgentLoop,
    private eventBus: InternalEventBus,
    private actionHandlerRegistry: ActionHandlerRegistry,
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

    // node-cron tasks can silently stop firing in long-running Bun processes.
    // Re-hydrate all cron items every 6 hours as a guard.
    this.rehydrateTimer = setInterval(() => {
      void this.rehydrateCronItems();
    }, 6 * 3600_000);
  }

  /** Stop all running schedules (for graceful shutdown). */
  stop(): void {
    if (this.rehydrateTimer) {
      clearInterval(this.rehydrateTimer);
      this.rehydrateTimer = undefined;
    }

    for (const task of this.cronTasks.values()) {
      task.stop();
    }
    this.cronTasks.clear();

    for (const timer of this.onceTimers.values()) {
      clearTimeout(timer);
    }
    this.onceTimers.clear();

    for (const timer of this.expiryTimers.values()) {
      clearTimeout(timer);
    }
    this.expiryTimers.clear();

    for (const handler of this.eventHandlers.values()) {
      const eventType = (handler as { _eventType?: string })._eventType;
      if (eventType) {
        this.eventBus.unsubscribe(eventType, handler);
      }
    }
    this.eventHandlers.clear();
    logger.info('[AgendaService] Stopped');
  }

  /**
   * Re-create all cron ScheduledTasks from DB. Guards against node-cron
   * silently dropping tasks in long-running Bun processes.
   */
  private async rehydrateCronItems(): Promise<void> {
    try {
      const items = await this.listItems({ enabledOnly: true });
      let count = 0;
      for (const item of items) {
        if (item.triggerType !== 'cron') continue;
        this.cancelSchedule(item.id);
        this.scheduleCron(item);
        count++;
      }
      logger.info(`[AgendaService] Rehydrated ${count} cron item(s)`);
    } catch (err) {
      logger.error('[AgendaService] Cron rehydration failed:', err);
    }
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

  /**
   * Create an agenda item on behalf of the LLM (schedule_task / watch_messages tools).
   * Single enforcement point for all LLM guardrails — limits are read from config
   * and applied here regardless of what the tool layer passed in:
   *   - chain depth cap (an agenda run registering further items)
   *   - live-item caps per group and global
   *   - once: delay within [minDelayMs, maxTtlMs]
   *   - onMessage: mandatory TTL (clamped), fire budget (clamped), keyword count/length bounds
   *   - cooldown floor
   * Returns an LLM-readable rejection instead of throwing so the tool result can
   * tell the model why registration failed.
   */
  async createLlmItem(request: LlmAgendaRequest): Promise<LlmAgendaResult> {
    const limits = this.config.getAgendaLlmLimits();
    const now = Date.now();

    if (request.chainDepth > limits.maxChainDepth) {
      return { ok: false, error: `自我调度链深度已达上限（${limits.maxChainDepth}），不能继续注册新任务` };
    }

    const prompt = request.prompt.trim();
    if (!prompt) {
      return { ok: false, error: 'prompt 不能为空' };
    }

    const liveItems = (await this.listItems({ enabledOnly: true })).filter((i) => this.isLlmItem(i));
    if (liveItems.length >= limits.maxLiveItemsGlobal) {
      return { ok: false, error: `全局 LLM 注册任务数已达上限（${limits.maxLiveItemsGlobal}），请等待现有任务过期` };
    }
    if (request.groupId) {
      const groupCount = liveItems.filter((i) => i.groupId === request.groupId).length;
      if (groupCount >= limits.maxLiveItemsPerGroup) {
        return {
          ok: false,
          error: `本群 LLM 注册任务数已达上限（${limits.maxLiveItemsPerGroup}），请等待现有任务过期`,
        };
      }
    }

    const base = {
      name: request.name?.trim() || `llm-${request.kind}-${new Date(now).toISOString().slice(0, 16)}`,
      groupId: request.groupId,
      userId: request.userId,
      intent: prompt,
      cooldownMs: limits.minCooldownMs,
      maxSteps: 15,
      enabled: true,
      fireCount: 0,
      metadata: JSON.stringify({ source: 'llm', chainDepth: request.chainDepth }),
    };

    if (request.kind === 'once') {
      if (!request.triggerAt) {
        return { ok: false, error: '定时任务必须指定触发时间' };
      }
      const triggerAtMs = new Date(request.triggerAt).getTime();
      if (Number.isNaN(triggerAtMs)) {
        return { ok: false, error: `无法解析触发时间：${request.triggerAt}` };
      }
      const delay = triggerAtMs - now;
      if (delay < limits.minDelayMs) {
        return { ok: false, error: `触发时间至少要在 ${Math.round(limits.minDelayMs / 1000)} 秒之后` };
      }
      if (delay > limits.maxTtlMs) {
        return { ok: false, error: `触发时间最多只能安排在 ${Math.round(limits.maxTtlMs / 3600_000)} 小时之内` };
      }
      const item = await this.createItem({
        ...base,
        triggerType: 'once',
        triggerAt: new Date(triggerAtMs).toISOString(),
      });
      return { ok: true, item };
    }

    // kind === 'onMessage'
    const keywords = (request.keywords ?? []).map((k) => k.trim()).filter((k) => k.length > 0);
    const uniqueKeywords = Array.from(new Set(keywords));
    if (uniqueKeywords.length === 0 && !request.watchUserId) {
      return { ok: false, error: '监听条件不能为空：至少提供关键词或目标用户之一' };
    }
    if (uniqueKeywords.length > limits.maxKeywords) {
      return { ok: false, error: `关键词最多 ${limits.maxKeywords} 个` };
    }
    const badKeyword = uniqueKeywords.find(
      (k) => k.length < limits.keywordMinLength || k.length > limits.keywordMaxLength,
    );
    if (badKeyword) {
      return {
        ok: false,
        error: `关键词「${badKeyword}」长度需在 ${limits.keywordMinLength}-${limits.keywordMaxLength} 字符之间（太短的词会误触发）`,
      };
    }

    const ttlMs = Math.min(Math.max(request.ttlMs ?? limits.defaultTtlMs, limits.minDelayMs), limits.maxTtlMs);
    const maxFires = Math.min(Math.max(Math.trunc(request.maxFires ?? limits.defaultMaxFires), 1), limits.maxFiresCap);

    const item = await this.createItem({
      ...base,
      triggerType: 'onMessage',
      watchKeywords: uniqueKeywords.length > 0 ? JSON.stringify(uniqueKeywords) : undefined,
      watchUserId: request.watchUserId,
      expiresAt: new Date(now + ttlMs).toISOString(),
      maxFires,
    });
    return { ok: true, item };
  }

  /** True when the item was registered by the LLM itself (metadata.source === 'llm'). */
  isLlmItem(item: AgendaItem): boolean {
    if (!item.metadata) return false;
    try {
      return (JSON.parse(item.metadata) as { source?: string }).source === 'llm';
    } catch {
      return false;
    }
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

    if (this.isExpired(item)) {
      logger.debug(`[AgendaService] Item "${item.name}" is past expiresAt; deleting`);
      void this.deleteItem(item.id);
      return;
    }

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
      case 'onMessage':
        this.subscribeMessage(item);
        break;
      default:
        logger.warn(`[AgendaService] Unknown triggerType "${item.triggerType}" for item "${item.name}"`);
    }

    this.armExpiry(item);
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

  /**
   * Subscribe an onMessage item to the pipeline's message-received events.
   * Matching semantics live in matchOnMessageEvent (onMessageMatch.ts).
   */
  private subscribeMessage(item: AgendaItem): void {
    const keywords = parseWatchKeywords(item.watchKeywords);
    if (!item.watchUserId && keywords.length === 0) {
      logger.warn(`[AgendaService] OnMessage item "${item.name}" has no watch condition, skipping`);
      return;
    }

    const handler = async (event: AgendaSystemEvent) => {
      if (event.data?.triggeredBot) return;
      const match = matchOnMessageEvent(item, keywords, event);
      if (!match.matched) return;

      const eventContext: AgendaEventContext = {
        eventType: MESSAGE_RECEIVED_EVENT,
        groupId: event.groupId || undefined,
        userId: event.userId,
        botSelfId: event.botSelfId,
        data: { ...event.data, matchedKeyword: match.matchedKeyword },
      };
      await this.fireItem(item, eventContext);
    };

    (handler as { _eventType?: string })._eventType = MESSAGE_RECEIVED_EVENT;
    this.eventBus.subscribe(MESSAGE_RECEIVED_EVENT, handler);
    this.eventHandlers.set(item.id, handler);
    logger.debug(
      `[AgendaService] Subscribed onMessage item "${item.name}" (keywords=${keywords.length}, watchUserId=${item.watchUserId ?? '-'})`,
    );
  }

  // ─── Lifetime (expiry / fire budget) ─────────────────────────────────────────

  private isExpired(item: AgendaItem): boolean {
    if (!item.expiresAt) return false;
    return Date.now() >= new Date(item.expiresAt).getTime();
  }

  /**
   * Arm a deletion timer for an item with expiresAt. setTimeout delays are
   * capped at 24h per arm and re-armed on fire, so far-future expiries don't
   * overflow the 32-bit timer range; isExpired checks at schedule/fire time
   * cover any drift.
   */
  private armExpiry(item: AgendaItem): void {
    if (!item.expiresAt) return;
    const remaining = new Date(item.expiresAt).getTime() - Date.now();
    const delay = Math.min(remaining, 24 * 3600_000);

    const timer = setTimeout(
      () => {
        this.expiryTimers.delete(item.id);
        if (this.isExpired(item)) {
          logger.info(`[AgendaService] Item "${item.name}" expired; deleting`);
          void this.deleteItem(item.id);
        } else {
          this.armExpiry(item);
        }
      },
      Math.max(delay, 0),
    );

    this.expiryTimers.set(item.id, timer);
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

    const expiryTimer = this.expiryTimers.get(id);
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      this.expiryTimers.delete(id);
    }
  }

  // ─── Execution ───────────────────────────────────────────────────────────────

  /**
   * Fire an agenda item: check cooldown, run AgentLoop, update lastRunAt.
   */
  private async fireItem(item: AgendaItem, eventContext: AgendaEventContext): Promise<void> {
    // Re-fetch from DB to get latest state (may have been updated/disabled since schedule was set)
    const fresh = await this.getItem(item.id);
    if (!fresh?.enabled) {
      logger.debug(`[AgendaService] Item "${item.name}" is disabled; skipping`);
      return;
    }

    if (this.isExpired(fresh)) {
      logger.info(`[AgendaService] Item "${fresh.name}" expired; deleting instead of firing`);
      await this.deleteItem(fresh.id);
      return;
    }

    // Cooldown gate (cron items skip this: the cron expression already controls frequency)
    if (fresh.triggerType !== 'cron' && !this.cooldownPassed(fresh)) {
      logger.debug(`[AgendaService] Item "${fresh.name}" in cooldown; skipping`);
      return;
    }

    // Action items: skip if the registered handler declares dependsOn plugins
    // that aren't currently enabled (e.g. wechatIngest disabled in config).
    // This prevents scheduled actions from firing into a no-op state and wasting
    // cycles / generating empty results.
    if (fresh.actionType === 'action' && fresh.actionTarget) {
      const missing = this.findMissingDependencies(fresh.actionTarget);
      if (missing.length > 0) {
        logger.info(
          `[AgendaService] Item "${fresh.name}" skipped: action handler "${fresh.actionTarget}" requires disabled plugin(s): ${missing.join(', ')}`,
        );
        return;
      }
    }

    logger.info(`[AgendaService] Firing item "${fresh.name}" (${fresh.id})`);
    const startedAt = new Date();
    const startedAtIso = startedAt.toISOString();
    // Failed runs also consume fire budget: an item that errors on every match
    // must still exhaust and die, or a broken watch would fire forever.
    const fireCount = (fresh.fireCount ?? 0) + 1;
    const budgetExhausted = fresh.maxFires != null && fireCount >= fresh.maxFires;

    try {
      switch (fresh.actionType) {
        case 'action':
          await this.agentLoop.runAction(fresh, eventContext, this.actionHandlerRegistry);
          break;
        case 'subagent':
          await this.agentLoop.runSubAgent(fresh, eventContext);
          break;
        case 'intent':
          await this.agentLoop.run(fresh, eventContext);
          break;
        default:
          await this.agentLoop.run(fresh, eventContext);
          break;
      }

      await this.reporter?.recordRun({
        item: fresh,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        success: true,
      });
      if (fresh.triggerType === 'once' || budgetExhausted) {
        await this.deleteItem(fresh.id);
      } else {
        await this.getAccessor().update(fresh.id, { lastRunAt: startedAtIso, fireCount });
      }
    } catch (err) {
      logger.error(`[AgendaService] Item "${fresh.name}" execution failed:`, err);
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.reporter?.recordRun({
        item: fresh,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        success: false,
        error: errMsg,
      });
      if (fresh.triggerType !== 'once' && budgetExhausted) {
        await this.deleteItem(fresh.id);
      } else {
        // Still update lastRunAt to respect cooldown even on failure (once items remain for retry semantics)
        await this.getAccessor().update(fresh.id, { lastRunAt: startedAtIso, fireCount });
      }
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

  /**
   * Look up the action handler by target name and return any plugins it
   * declares in `dependsOn` that aren't currently in PluginManager's
   * enabled set. Returns [] when handler is unknown (let the normal
   * dispatch path raise the missing-handler error) or has no deps.
   */
  private findMissingDependencies(actionTarget: string): string[] {
    const handler = this.actionHandlerRegistry.get(actionTarget);
    if (!handler?.dependsOn?.length) return [];
    const pluginManager = getContainer().resolve<PluginManager>(DITokens.PLUGIN_MANAGER);
    const enabled = new Set(pluginManager.getEnabledPlugins());
    return handler.dependsOn.filter((name) => !enabled.has(name));
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
