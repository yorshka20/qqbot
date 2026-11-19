// BaseFanout — the base every fan-out extends, as tool executors extend BaseToolExecutor.
//
// A subclass is a @singleton() class listed in FANOUT_CONTEXTS. It passes FanoutServices
// to super and injects only what its own context needs. It says what the shared context
// is (buildContext), which system prompt and model the run uses, and nothing else. Task selection, the envelope, the hook context
// tools run under and the one-run-per-target guard all live here, so no subclass can
// assemble an envelope that differs between the tasks of one run.

import type { LLMTarget } from '@qqbot/llm';
import { logger } from '@qqbot/shared';
import { HookContextBuilder } from '@/context/HookContextBuilder';
import type { NormalizedMessageEvent } from '@/events/types';
import type { HookContext } from '@/hooks/types';
import type { ToolSpec } from '@/tools/types';
import type { FanoutServices } from './FanoutServices';
import { type FanoutEnvelope, type PreparedTask, runSharedPrefixTasks, withTaskSuffix } from './SharedPrefixRunner';
import type {
  DeferredFanoutTask,
  FanoutRun,
  FanoutRunReport,
  FanoutTarget,
  FanoutTask,
  FanoutTaskReport,
} from './types';

interface PreparedDeferredTask<C> {
  task: DeferredFanoutTask<C>;
  params: unknown;
}

export interface FanoutContext<C> {
  ctx: C;
  /** Rendered shared prefix: the start of every task's user message. */
  prefix: string;
}

export abstract class BaseFanout<C> {
  abstract readonly name: string;
  protected abstract readonly systemTemplate: string;
  /** The LLM every task of a run shares: a different target is a different prefix cache. */
  protected abstract resolveTarget(): LLMTarget;
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
      const { live, deferred } = this.prepareTasks(requested);
      if (live.length === 0 && deferred.length === 0) {
        return { status: 'no_tasks' };
      }
      const context = await this.buildContext(target);
      if (!context) {
        logger.info(`[Fanout] ${this.name}: nothing to run on for ${key}`);
        return { status: 'no_context' };
      }
      const run: FanoutRun<C> = { ctx: context.ctx, target };
      const deferredReports = await this.deferTasks(deferred, context.prefix, run);
      const liveReports =
        live.length === 0
          ? []
          : await runSharedPrefixTasks(
              {
                fanoutName: this.name,
                envelope: this.buildEnvelope(live),
                prefix: context.prefix,
                run,
                tasks: live,
                hookContext: this.buildHookContext(target),
              },
              this.services,
            );
      return { status: 'ran', tasks: [...liveReports, ...deferredReports] };
    } finally {
      this.running.delete(key);
    }
  }

  /** Requested tasks that are registered and whose tools exist, in name order. */
  private prepareTasks(requested: Record<string, unknown>): {
    live: PreparedTask<C>[];
    deferred: PreparedDeferredTask<C>[];
  } {
    const live: PreparedTask<C>[] = [];
    const deferred: PreparedDeferredTask<C>[] = [];
    for (const name of Object.keys(requested).sort()) {
      const task = this.tasks.get(name);
      if (!task) {
        logger.warn(`[Fanout] ${this.name}: task ${name} is not registered, skipped`);
        continue;
      }
      if (task.mode === 'live') {
        const missing = task.tools.filter((tool) => !this.services.toolManager.getTool(tool));
        if (missing.length > 0) {
          logger.warn(`[Fanout] ${this.name}: task ${name} needs unregistered tool(s) ${missing.join(', ')}, skipped`);
          continue;
        }
      }
      try {
        const params = task.parseParams(requested[name]);
        if (task.mode === 'live') {
          live.push({ task, params });
        } else {
          deferred.push({ task, params });
        }
      } catch (err) {
        logger.warn(`[Fanout] ${this.name}: task ${name} has unusable params, skipped:`, err);
      }
    }
    return { live, deferred };
  }

  /** Hand each deferred task the request it would have made in this run. */
  private async deferTasks(
    deferred: PreparedDeferredTask<C>[],
    prefix: string,
    run: FanoutRun<C>,
  ): Promise<FanoutTaskReport[]> {
    if (deferred.length === 0) {
      return [];
    }
    const system = this.services.promptManager.render(this.systemTemplate);
    const reports: FanoutTaskReport[] = [];
    for (const { task, params } of deferred) {
      try {
        await task.defer({ system, prompt: withTaskSuffix(prefix, task.suffix(run, params)) }, run, params);
        reports.push({ name: task.name, status: 'deferred', rounds: 0 });
      } catch (err) {
        logger.error(`[Fanout] ${this.name}/${task.name} could not be deferred:`, err);
        reports.push({ name: task.name, status: 'failed', rounds: 0 });
      }
    }
    return reports;
  }

  private buildEnvelope(prepared: PreparedTask<C>[]): FanoutEnvelope {
    const names = [...new Set(prepared.flatMap(({ task }) => task.tools))].sort();
    const specs = names.map((name) => this.services.toolManager.getTool(name)).filter((s): s is ToolSpec => !!s);
    return {
      target: this.resolveTarget(),
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
