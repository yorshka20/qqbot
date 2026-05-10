/**
 * Functional integration tests: non-whitelist vs whitelist behaviour.
 * Only verify that messages reach plugins and are processed (trigger flow). No real DB write, RAG write, or file download.
 *
 * - Non-whitelist: reply/process MUST be skipped; COMPLETE stage runs so DB/RAG systems are triggered.
 * - Whitelist: messageTrigger, proactive, and command MUST be able to run; COMPLETE runs so DB/RAG triggered.
 * - GroupDownload: message event reaches plugin and handler is invoked (no real download).
 */
import 'reflect-metadata';

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { PromptManager } from '@/ai/prompt/PromptManager';
import { ProviderRouter } from '@/ai/routing/ProviderRouter';
import { CommandBuilder } from '@/command/CommandBuilder';
import { CommandRouter } from '@/conversation/CommandRouter';
import { Lifecycle } from '@/conversation/Lifecycle';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { System } from '@/core/system';
import { SystemPriority, SystemStage } from '@/core/system';
import { HookManager } from '@/hooks/HookManager';
import { getHookPriority } from '@/hooks/HookPriority';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { getPluginHooks } from '@/plugins/decorators';
import { GroupDownloadPlugin } from '../GroupDownloadPlugin';
import { MessageTriggerPlugin } from '../MessageTriggerPlugin';
import { ProactiveConversationPlugin } from '../ProactiveConversationPlugin';
import { WhitelistPlugin } from '../WhitelistPlugin';

// ---- Spy systems: only record that COMPLETE stage ran (trigger); no real DB/RAG write ----

function createSpySystem(name: string, record: { called: boolean }): System {
  return {
    name,
    version: '1.0.0',
    stage: SystemStage.COMPLETE,
    priority: SystemPriority.DatabasePersistence,
    enabled: () => true,
    execute(_context: HookContext) {
      record.called = true;
      return true;
    },
  };
}

function makeHookContext(opts: {
  messageText: string;
  messageType?: 'private' | 'group';
  userId?: number;
  groupId?: number;
  botSelfId?: string;
  sessionId?: string;
  sessionType?: 'group' | 'user';
  command?: { name: string; args: string[] };
  segments?: Array<{ type: string; data?: Record<string, unknown> }>;
}): HookContext {
  const {
    messageText,
    messageType = 'group',
    userId = 456,
    groupId = 1,
    botSelfId = '123',
    sessionId = 'group:1',
    sessionType = 'group',
    command: commandOpt,
    segments = [],
  } = opts;
  const command = commandOpt ? CommandBuilder.build(commandOpt.name, commandOpt.args) : undefined;
  const metadata = new HookMetadataMap();
  metadata.set('botSelfId', botSelfId);
  metadata.set('sessionId', sessionId);
  metadata.set('sessionType', sessionType);
  return {
    command,
    message: {
      id: 'm1',
      type: 'message',
      timestamp: Date.now(),
      protocol: 'milky',
      userId,
      groupId: messageType === 'group' ? groupId : undefined,
      messageType,
      message: messageText,
      segments,
    },
    context: {
      userMessage: messageText,
      history: [],
      userId,
      groupId: messageType === 'group' ? groupId : undefined,
      messageType,
      metadata: new Map(),
    },
    metadata,
    source: (messageType === 'private' ? 'qq-private' : 'qq-group') as import('@/conversation/sources').MessageSource,
  };
}

function registerPluginHooks(
  hookManager: HookManager,
  plugin: InstanceType<typeof WhitelistPlugin | typeof MessageTriggerPlugin | typeof ProactiveConversationPlugin>,
  pluginClass: typeof WhitelistPlugin | typeof MessageTriggerPlugin | typeof ProactiveConversationPlugin,
): void {
  const hooks = getPluginHooks(pluginClass);
  for (const hookMeta of hooks) {
    const handler = (plugin as unknown as Record<string, unknown>)[hookMeta.methodName];
    if (typeof handler !== 'function') {
      continue;
    }
    const priority = getHookPriority(hookMeta.hookName, hookMeta.priority, hookMeta.order);
    hookManager.addHandler(
      hookMeta.hookName,
      (handler as (ctx: HookContext) => boolean | Promise<boolean>).bind(plugin),
      priority,
    );
  }
}

describe('Whitelist functional: non-whitelist skipped but DB+RAG run', () => {
  let hookManager: HookManager;
  let lifecycle: Lifecycle;
  let dbSpy: { called: boolean };
  let ragSpy: { called: boolean };

  afterEach(() => {
    getContainer().clear();
  });

  async function setupLifecycle(whitelistGroupIds: string[]) {
    hookManager = new HookManager();
    const commandRouter = new CommandRouter(['/', '!']);
    lifecycle = new Lifecycle(hookManager, commandRouter);

    dbSpy = { called: false };
    ragSpy = { called: false };
    lifecycle.registerSystem(createSpySystem('database-persistence', dbSpy));
    lifecycle.registerSystem(createSpySystem('rag-persistence', ragSpy));

    const whitelist = new WhitelistPlugin({ name: 'whitelist', version: 'test', description: 'test' });
    whitelist.loadConfig(
      { api: {} as never, events: {} as never },
      { name: 'whitelist', enabled: true, config: { groupIds: whitelistGroupIds } },
    );
    await whitelist.onInit?.();
    registerPluginHooks(hookManager, whitelist, WhitelistPlugin);

    const container = getContainer();
    const promptManager = new PromptManager();
    container.registerInstance(DITokens.PROMPT_MANAGER, promptManager, { allowOverride: true });
    container.registerInstance(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
      { getGroupPreferenceKeys: () => [], isGroupSuppressed: () => false },
      { allowOverride: true },
    );
    container.registerInstance(
      DITokens.THREAD_SERVICE,
      { getActiveThread: () => null, hasActiveThread: () => false },
      { allowOverride: true },
    );
    container.registerInstance(
      DITokens.LLM_SERVICE,
      { generateLite: async () => ({ text: 'true' }) },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.CONFIG, { getAIConfig: () => undefined }, { allowOverride: true });
    container.registerInstance(
      DITokens.PROVIDER_ROUTER,
      new ProviderRouter({ getProviderForCapability: () => ({ isAvailable: () => true }) } as never),
      { allowOverride: true },
    );
    const trigger = new MessageTriggerPlugin({ name: 'messageTrigger', version: 'test', description: 'test' });
    trigger.loadConfig(
      { api: {} as never, events: {} as never },
      { name: 'messageTrigger', enabled: true, config: {} },
    );
    await trigger.onInit?.();
    registerPluginHooks(hookManager, trigger, MessageTriggerPlugin);
  }

  it('non-whitelist group: reply path skipped (no PROCESS), COMPLETE runs so DB and RAG systems are triggered', async () => {
    await setupLifecycle(['999']);
    const context = makeHookContext({ messageText: 'hello', groupId: 1 });
    await lifecycle.execute(context);

    expect(context.metadata.get('whitelistDenied')).toBe(true);
    expect(context.reply).toBeUndefined();
    expect(dbSpy.called).toBe(true);
    expect(ragSpy.called).toBe(true);
  });
});

describe('Whitelist functional: whitelist group can trigger proactive, messageTrigger, cmd; DB+RAG run', () => {
  let hookManager: HookManager;
  let lifecycle: Lifecycle;
  let dbSpy: { called: boolean };
  let ragSpy: { called: boolean };

  afterEach(() => {
    getContainer().clear();
  });

  async function setupLifecycleWithProactive() {
    hookManager = new HookManager();
    const commandRouter = new CommandRouter(['/', '!']);
    lifecycle = new Lifecycle(hookManager, commandRouter);

    dbSpy = { called: false };
    ragSpy = { called: false };
    lifecycle.registerSystem(createSpySystem('database-persistence', dbSpy));
    lifecycle.registerSystem(createSpySystem('rag-persistence', ragSpy));

    const whitelist = new WhitelistPlugin({ name: 'whitelist', version: 'test', description: 'test' });
    whitelist.loadConfig(
      { api: {} as never, events: {} as never },
      { name: 'whitelist', enabled: true, config: { groupIds: ['1'] } },
    );
    await whitelist.onInit?.();
    registerPluginHooks(hookManager, whitelist, WhitelistPlugin);

    const container = getContainer();
    const promptManager = new PromptManager();
    promptManager.registerTemplate({ name: 'acg.trigger', namespace: 'preference', content: 'hello' });
    container.registerInstance(DITokens.PROMPT_MANAGER, promptManager, { allowOverride: true });
    const scheduleForGroup = mock(() => {});
    container.registerInstance(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
      {
        getGroupPreferenceKeys: () => [],
        setGroupConfig: () => {},
        setAnalysisProvider: () => {},
        setGroupSuppressed: () => {},
        isGroupSuppressed: () => false,
        scheduleForGroup,
      },
      { allowOverride: true },
    );
    container.registerInstance(
      DITokens.THREAD_SERVICE,
      { getActiveThread: () => null, hasActiveThread: () => false },
      { allowOverride: true },
    );
    container.registerInstance(
      DITokens.LLM_SERVICE,
      { generateLite: async () => ({ text: 'true' }) },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.CONFIG, { getAIConfig: () => undefined }, { allowOverride: true });
    container.registerInstance(
      DITokens.PROVIDER_ROUTER,
      new ProviderRouter({ getProviderForCapability: () => ({ isAvailable: () => true }) } as never),
      { allowOverride: true },
    );
    container.registerInstance(DITokens.COMMAND_MANAGER, { register: () => {} } as never, { allowOverride: true });

    const trigger = new MessageTriggerPlugin({ name: 'messageTrigger', version: 'test', description: 'test' });
    trigger.loadConfig(
      { api: {} as never, events: {} as never },
      { name: 'messageTrigger', enabled: true, config: { wakeWords: ['wakebot'] } },
    );
    await trigger.onInit?.();
    registerPluginHooks(hookManager, trigger, MessageTriggerPlugin);

    const proactive = new ProactiveConversationPlugin({
      name: 'proactiveConversation',
      version: 'test',
      description: 'test',
    });
    proactive.loadConfig(
      { api: {} as never, events: {} as never },
      { name: 'proactiveConversation', enabled: true, config: { groups: [{ groupId: '1', preferenceKey: 'acg' }] } },
    );
    await proactive.onInit?.();
    registerPluginHooks(hookManager, proactive, ProactiveConversationPlugin);

    return { scheduleForGroup };
  }

  it('whitelist group + wake word: messageTrigger sets replyTriggerType, COMPLETE triggers DB+RAG', async () => {
    await setupLifecycleWithProactive();
    const context = makeHookContext({ messageText: 'wakebot hello', groupId: 1 });
    await lifecycle.execute(context);

    expect(context.metadata.get('whitelistDenied')).toBeUndefined();
    expect(context.metadata.get('whitelistGroup')).toBe(true);
    expect(context.metadata.get('replyTriggerType')).toBe('wakeWordConfig');
    expect(dbSpy.called).toBe(true);
    expect(ragSpy.called).toBe(true);
  });

  it('whitelist group + no trigger: postProcessOnly set, proactive schedules, COMPLETE triggers DB+RAG', async () => {
    const { scheduleForGroup } = await setupLifecycleWithProactive();
    const context = makeHookContext({ messageText: 'say hello', groupId: 1 });
    await lifecycle.execute(context);

    expect(context.metadata.get('postProcessOnly')).toBe(true);
    expect(context.metadata.get('whitelistGroup')).toBe(true);
    expect(scheduleForGroup).toHaveBeenCalled();
    expect(dbSpy.called).toBe(true);
    expect(ragSpy.called).toBe(true);
  });

  it('whitelist group + command: command routed and COMPLETE triggers DB+RAG', async () => {
    await setupLifecycleWithProactive();
    const context = makeHookContext({ messageText: '/echo', groupId: 1, command: { name: 'echo', args: [] } });
    await lifecycle.execute(context);

    expect(context.metadata.get('whitelistDenied')).toBeUndefined();
    expect(context.command?.name).toBe('echo');
    expect(dbSpy.called).toBe(true);
    expect(ragSpy.called).toBe(true);
  });
});

describe('GroupDownload functional: plugin uses onMessageComplete hook at COMPLETE stage (no real download)', () => {
  afterEach(() => {
    getContainer().clear();
  });

  it('GroupDownloadPlugin registers onMessageComplete hook so it runs at COMPLETE stage', () => {
    const hooks = getPluginHooks(GroupDownloadPlugin);
    expect(hooks.length).toBe(1);
    expect(hooks[0].hookName).toBe('onMessageComplete');
    expect(hooks[0].methodName).toBe('onMessageComplete');
  });

  it('when lifecycle runs COMPLETE (onMessageComplete), GroupDownload handler is actually invoked', async () => {
    getContainer().registerInstance(
      DITokens.MESSAGE_API,
      { getResourceTempUrl: async () => null },
      { allowOverride: true },
    );

    const plugin = new GroupDownloadPlugin({
      name: 'groupDownload',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      { api: {} as never, events: {} as never },
      { name: 'groupDownload', enabled: true, config: { groupIds: ['1'] } },
    );
    await plugin.onInit?.();

    const original = plugin.onMessageComplete.bind(plugin);
    let handlerCalled = false;
    (plugin as unknown as { onMessageComplete: (ctx: HookContext) => boolean }).onMessageComplete = (ctx) => {
      handlerCalled = true;
      return original(ctx);
    };

    const hookManager = new HookManager();
    const hooks = getPluginHooks(GroupDownloadPlugin);
    for (const hookMeta of hooks) {
      const handler = (plugin as unknown as Record<string, (ctx: HookContext) => boolean>)[hookMeta.methodName];
      if (typeof handler !== 'function') {
        continue;
      }
      const priority = getHookPriority(hookMeta.hookName, hookMeta.priority, hookMeta.order);
      hookManager.addHandler(hookMeta.hookName, handler.bind(plugin), priority);
    }

    const context = makeHookContext({ messageText: 'hello', groupId: 1, segments: [] });
    await hookManager.execute('onMessageComplete', context);

    expect(handlerCalled).toBe(true);
  });
});
