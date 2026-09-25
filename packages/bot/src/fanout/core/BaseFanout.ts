// BaseFanout — the base every fan-out extends, as tool executors extend BaseToolExecutor.
//
// A subclass is a @singleton() class listed in FANOUT_CONTEXTS. It passes FanoutServices
// to super and injects only what its own context needs. It says what the shared context
// is (buildContext), which system prompt and model the run uses, and nothing else. Task selection, the envelope, the hook context
// tools run under and the one-run-per-target guard all live here, so no subclass can
// assemble an envelope that differs between the tasks of one run.

import { HookContextBuilder } from '@/context/HookContextBuilder';
import type { NormalizedMessageEvent } from '@/events/types';
import type { HookContext } from '@/hooks/types';
import type { ToolSpec } from '@/tools/types';
import { logger } from '@/utils/logger';
import type { FanoutServices } from './FanoutServices';
import { type FanoutEnvelope, type PreparedTask, runSharedPrefixTasks } from './SharedPrefixRunner';
import type { FanoutRun, FanoutRunReport, FanoutTarget, FanoutTask } from './types';

export interface FanoutModel {
  provider: string;
  model?: string;
}

export interface FanoutContext<C> {
  ctx: C;
  /** Rendered shared prefix: the start of every task's user message. */
  prefix: string;
}

export abstract class BaseFanout<C> {
  abstract readonly name: string;
  protected abstract readonly systemTemplate: string;
  protected abstract resolveModel(): FanoutModel;
  /** Null when there is nothing to run on (e.g. an empty day); the run is skipped. */
  protected abstract buildContext(target: FanoutTarget): Promise<FanoutContext<C> | null>;

  private readonly tasks = new Map<string, FanoutTask<C>>();
  private readonly running = new Set<string>();

  constructor(protected readonly services: FanoutServices) {}

  registerTask(task: FanoutTask<C>): void {
    if (this.tasks.has(task.name)) {
      logger.warn(`[Fanout] ${this.name}: overwriting task ${task.name}`);
    }
    this.tasks.set(task.name, task);
  }

  unregisterTask(name: string): void {
    this.tasks.delete(name);
  }

  /**
   * Run the requested tasks on one target. `requested` maps a task name to that task's
   * own parameters, which only the task parses.
   */
  async run(target: FanoutTarget, requested: Record<string, unknown>): Promise<FanoutRunReport> {
    const key = `${target.chat}:${target.id}`;
    if (this.running.has(key)) {
      logger.info(`[Fanout] ${this.name}: a run for ${key} is already in progress`);
      return { status: 'busy' };
    }
    this.running.add(key);
    try {
      const prepared = this.prepareTasks(requested);
      if (prepared.length === 0) {
        return { status: 'no_tasks' };
      }
      const context = await this.buildContext(target);
      if (!context) {
        logger.info(`[Fanout] ${this.name}: nothing to run on for ${key}`);
        return { status: 'no_context' };
      }
      const run: FanoutRun<C> = { ctx: context.ctx, target };
      const tasks = await runSharedPrefixTasks(
        {
          fanoutName: this.name,
          envelope: this.buildEnvelope(prepared),
          prefix: context.prefix,
          run,
          tasks: prepared,
          hookContext: this.buildHookContext(target),
        },
        this.services,
      );
      return { status: 'ran', tasks };
    } finally {
      this.running.delete(key);
    }
  }

  /** Requested tasks that are registered and whose tools exist, in name order. */
  private prepareTasks(requested: Record<string, unknown>): PreparedTask<C>[] {
    const prepared: PreparedTask<C>[] = [];
    for (const name of Object.keys(requested).sort()) {
      const task = this.tasks.get(name);
      if (!task) {
        logger.warn(`[Fanout] ${this.name}: task ${name} is not registered, skipped`);
        continue;
      }
      const missing = task.tools.filter((tool) => !this.services.toolManager.getTool(tool));
      if (missing.length > 0) {
        logger.warn(`[Fanout] ${this.name}: task ${name} needs unregistered tool(s) ${missing.join(', ')}, skipped`);
        continue;
      }
      try {
        prepared.push({ task, params: task.parseParams(requested[name]) });
      } catch (err) {
        logger.warn(`[Fanout] ${this.name}: task ${name} has unusable params, skipped:`, err);
      }
    }
    return prepared;
  }

  private buildEnvelope(prepared: PreparedTask<C>[]): FanoutEnvelope {
    const names = [...new Set(prepared.flatMap(({ task }) => task.tools))].sort();
    const specs = names.map((name) => this.services.toolManager.getTool(name)).filter((s): s is ToolSpec => !!s);
    const { provider, model } = this.resolveModel();
    return {
      provider,
      model,
      system: this.services.promptManager.render(this.systemTemplate),
      tools: this.services.toolManager.toToolDefinitions(specs),
    };
  }

  /** Tools run as the bot itself, in the target chat, whoever triggered the run. */
  private buildHookContext(target: FanoutTarget): HookContext {
    const isGroup = target.chat === 'group';
    const chatId = Number(target.id);
    const botId = Number(this.services.botSelfId);
    const text = `[fanout] ${this.name}`;
    const message: NormalizedMessageEvent = {
      id: `fanout-${this.name}-${Date.now()}`,
      type: 'message',
      timestamp: Date.now(),
      protocol: target.protocol,
      messageType: isGroup ? 'group' : 'private',
      userId: isGroup ? botId : chatId,
      groupId: isGroup ? chatId : 0,
      message: text,
      segments: [],
    };
    const sessionId = isGroup ? `group:${chatId}` : `private:${chatId}`;
    return HookContextBuilder.fromMessage(message, {
      sessionId,
      sessionType: isGroup ? 'group' : 'user',
      conversationId: `fanout-${this.name}-${sessionId}`,
      botSelfId: this.services.botSelfId,
      userId: message.userId,
      groupId: isGroup ? chatId : 0,
      senderRole: '',
    })
      .withConversationContext({
        userMessage: text,
        history: [],
        userId: message.userId,
        groupId: message.groupId,
        messageType: message.messageType,
        metadata: new Map(),
      })
      .build();
  }
}
