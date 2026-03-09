import 'reflect-metadata';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { PromptManager } from '@/ai/prompt/PromptManager';
import { CommandBuilder } from '@/command/CommandBuilder';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { ProactiveConversationPlugin } from '../ProactiveConversationPlugin';

interface ProactiveContextOverrides {
  whitelistDenied?: boolean;
  postProcessOnly?: boolean;
  whitelistGroup?: boolean;
  /** Set to skip direct-reply path (proactive can still run). Omit or false = set default replyTriggerType. */
  noReplyTrigger?: boolean;
  replyTriggerType?: 'at' | 'reaction' | 'wakeWordConfig' | 'wakeWordPreference' | 'providerName';
  messageType?: 'group' | 'private';
  groupId?: number;
  userId?: number;
  botSelfId?: string;
  command?: { name: string; args: string[] };
}

function makeGroupHookContext(messageText: string, overrides?: ProactiveContextOverrides): HookContext {
  const metadata = new HookMetadataMap();
  const botSelfId = overrides?.botSelfId ?? '123';
  const userId = overrides?.userId ?? 456;
  const groupId = overrides?.groupId ?? 1;
  const messageType = overrides?.messageType ?? 'group';
  metadata.set('botSelfId', botSelfId);
  if (overrides?.noReplyTrigger) {
    // Do not set replyTriggerType so proactive path can run
  } else if (overrides?.replyTriggerType !== undefined) {
    metadata.set('replyTriggerType', overrides.replyTriggerType);
  } else {
    metadata.set('replyTriggerType', 'wakeWordConfig');
  }
  if (overrides?.whitelistDenied !== undefined) {
    metadata.set('whitelistDenied', overrides.whitelistDenied);
  }
  if (overrides?.postProcessOnly !== undefined) {
    metadata.set('postProcessOnly', overrides.postProcessOnly);
  }
  if (overrides?.whitelistGroup !== undefined) {
    metadata.set('whitelistGroup', overrides.whitelistGroup);
  }
  const command = overrides?.command ? CommandBuilder.build(overrides.command.name, overrides.command.args) : undefined;
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
      segments: [],
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
  };
}

describe('ProactiveConversationPlugin wake-word dedupe', () => {
  afterEach(() => {
    getContainer().clear();
  });

  it('skips proactive scheduling when message already triggered direct reply by wake-word', async () => {
    const container = getContainer();
    const scheduleForGroup = mock(() => {});
    const proactiveService = {
      setGroupConfig: () => {},
      setAnalysisProvider: () => {},
      scheduleForGroup,
    };
    container.registerInstance(DITokens.PROACTIVE_CONVERSATION_SERVICE, proactiveService, { allowOverride: true });
    container.registerInstance(
      DITokens.THREAD_SERVICE,
      {
        getActiveThread: () => null,
      },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.PROMPT_MANAGER, new PromptManager(), { allowOverride: true });

    const plugin = new ProactiveConversationPlugin({
      name: 'proactiveConversation',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      {
        api: {} as never,
        events: {} as never,
      },
      {
        name: 'proactiveConversation',
        enabled: true,
        config: { groups: [{ groupId: '1', preferenceKey: 'acg' }] },
      },
    );
    await plugin.onInit?.();

    const context = makeGroupHookContext('wakebot hello');
    const result = plugin.onMessageComplete(context);

    expect(result).toBe(true);
    expect(scheduleForGroup).not.toHaveBeenCalled();
  });

  it('skips proactive scheduling when whitelistDenied', async () => {
    const container = getContainer();
    const scheduleForGroup = mock(() => {});
    container.registerInstance(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
      { setGroupConfig: () => {}, setAnalysisProvider: () => {}, scheduleForGroup },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.THREAD_SERVICE, { getActiveThread: () => null }, { allowOverride: true });
    container.registerInstance(DITokens.PROMPT_MANAGER, new PromptManager(), { allowOverride: true });

    const plugin = new ProactiveConversationPlugin({
      name: 'proactiveConversation',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      { api: {} as never, events: {} as never },
      { name: 'proactiveConversation', enabled: true, config: { groups: [{ groupId: '1', preferenceKey: 'acg' }] } },
    );
    await plugin.onInit?.();

    const context = makeGroupHookContext('hello', { whitelistDenied: true, noReplyTrigger: true });
    const result = plugin.onMessageComplete(context);

    expect(result).toBe(true);
    expect(scheduleForGroup).not.toHaveBeenCalled();
  });

  it('schedules proactive when postProcessOnly but whitelistGroup (no direct reply trigger)', async () => {
    const container = getContainer();
    const scheduleForGroup = mock(() => {});
    const promptManager = new PromptManager();
    promptManager.registerTemplate({
      name: 'acg.trigger',
      namespace: 'preference',
      content: 'hello',
    });
    container.registerInstance(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
      { setGroupConfig: () => {}, setAnalysisProvider: () => {}, scheduleForGroup },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.THREAD_SERVICE, { getActiveThread: () => null }, { allowOverride: true });
    container.registerInstance(DITokens.PROMPT_MANAGER, promptManager, { allowOverride: true });

    const plugin = new ProactiveConversationPlugin({
      name: 'proactiveConversation',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      { api: {} as never, events: {} as never },
      { name: 'proactiveConversation', enabled: true, config: { groups: [{ groupId: '1', preferenceKey: 'acg' }] } },
    );
    await plugin.onInit?.();

    const context = makeGroupHookContext('hello', {
      postProcessOnly: true,
      whitelistGroup: true,
      noReplyTrigger: true,
    });
    const result = plugin.onMessageComplete(context);

    expect(result).toBe(true);
    expect(scheduleForGroup).toHaveBeenCalled();
  });
});

describe('ProactiveConversationPlugin skip and schedule coverage', () => {
  afterEach(() => {
    getContainer().clear();
  });

  async function setupPlugin(opts: {
    enabled?: boolean;
    groups?: Array<{ groupId: string; preferenceKey: string }>;
    scheduleForGroup?: ReturnType<typeof mock>;
  }) {
    const scheduleForGroup = opts.scheduleForGroup ?? mock(() => {});
    const container = getContainer();
    const promptManager = new PromptManager();
    promptManager.registerTemplate({
      name: 'acg.trigger',
      namespace: 'preference',
      content: 'hello\nworld',
    });
    container.registerInstance(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
      { setGroupConfig: () => {}, setAnalysisProvider: () => {}, scheduleForGroup },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.THREAD_SERVICE, { getActiveThread: () => null }, { allowOverride: true });
    container.registerInstance(DITokens.PROMPT_MANAGER, promptManager, { allowOverride: true });

    const plugin = new ProactiveConversationPlugin({
      name: 'proactiveConversation',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      { api: {} as never, events: {} as never },
      {
        name: 'proactiveConversation',
        enabled: opts.enabled !== false,
        config: { groups: opts.groups ?? [{ groupId: '1', preferenceKey: 'acg' }] },
      },
    );
    await plugin.onInit?.();
    return { plugin, scheduleForGroup };
  }

  it('does not schedule when plugin disabled', async () => {
    const container = getContainer();
    const scheduleForGroup = mock(() => {});
    container.registerInstance(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
      { setGroupConfig: () => {}, setAnalysisProvider: () => {}, scheduleForGroup },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.THREAD_SERVICE, { getActiveThread: () => null }, { allowOverride: true });
    container.registerInstance(DITokens.PROMPT_MANAGER, new PromptManager(), { allowOverride: true });

    const plugin = new ProactiveConversationPlugin({
      name: 'proactiveConversation',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      { api: {} as never, events: {} as never },
      { name: 'proactiveConversation', enabled: false, config: { groups: [{ groupId: '1', preferenceKey: 'acg' }] } },
    );
    await plugin.onInit?.();

    const context = makeGroupHookContext('hello', { noReplyTrigger: true });
    plugin.onMessageComplete(context);
    expect(scheduleForGroup).not.toHaveBeenCalled();
  });

  it('does not schedule when no groups configured', async () => {
    const container = getContainer();
    const scheduleForGroup = mock(() => {});
    container.registerInstance(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
      { setGroupConfig: () => {}, setAnalysisProvider: () => {}, scheduleForGroup },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.THREAD_SERVICE, { getActiveThread: () => null }, { allowOverride: true });
    container.registerInstance(DITokens.PROMPT_MANAGER, new PromptManager(), { allowOverride: true });

    const plugin = new ProactiveConversationPlugin({
      name: 'proactiveConversation',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      { api: {} as never, events: {} as never },
      { name: 'proactiveConversation', enabled: true, config: { groups: [] } },
    );
    await plugin.onInit?.();

    const context = makeGroupHookContext('hello', { noReplyTrigger: true });
    plugin.onMessageComplete(context);
    expect(scheduleForGroup).not.toHaveBeenCalled();
  });

  it('does not schedule for private message', async () => {
    const { plugin, scheduleForGroup } = await setupPlugin({});
    const context = makeGroupHookContext('hello', {
      messageType: 'private',
      groupId: undefined as unknown as number,
      noReplyTrigger: true,
    });
    plugin.onMessageComplete(context);
    expect(scheduleForGroup).not.toHaveBeenCalled();
  });

  it('does not schedule when group not in proactive groupIds', async () => {
    const { plugin, scheduleForGroup } = await setupPlugin({});
    const context = makeGroupHookContext('hello', { groupId: 2, noReplyTrigger: true });
    plugin.onMessageComplete(context);
    expect(scheduleForGroup).not.toHaveBeenCalled();
  });

  it('does not schedule for bot own message', async () => {
    const { plugin, scheduleForGroup } = await setupPlugin({});
    const context = makeGroupHookContext('hello', {
      userId: 123,
      botSelfId: '123',
      noReplyTrigger: true,
    });
    plugin.onMessageComplete(context);
    expect(scheduleForGroup).not.toHaveBeenCalled();
  });

  it('does not schedule when context.command is set', async () => {
    const { plugin, scheduleForGroup } = await setupPlugin({});
    const context = makeGroupHookContext('/echo', {
      command: { name: 'echo', args: [] },
      noReplyTrigger: true,
    });
    plugin.onMessageComplete(context);
    expect(scheduleForGroup).not.toHaveBeenCalled();
  });

  it('schedules when in active thread and message from thread trigger user', async () => {
    const scheduleForGroup = mock(() => {});
    const container = getContainer();
    const promptManager = new PromptManager();
    promptManager.registerTemplate({ name: 'acg.trigger', namespace: 'preference', content: 'x' });
    container.registerInstance(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
      { setGroupConfig: () => {}, setAnalysisProvider: () => {}, scheduleForGroup },
      { allowOverride: true },
    );
    container.registerInstance(
      DITokens.THREAD_SERVICE,
      {
        getActiveThread: (gid: string) => (gid === '1' ? { triggerUserId: '456' } : null),
        getCurrentThreadId: () => '',
      },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.PROMPT_MANAGER, promptManager, { allowOverride: true });

    const plugin = new ProactiveConversationPlugin({
      name: 'proactiveConversation',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      { api: {} as never, events: {} as never },
      { name: 'proactiveConversation', enabled: true, config: { groups: [{ groupId: '1', preferenceKey: 'acg' }] } },
    );
    await plugin.onInit?.();

    const context = makeGroupHookContext('random text', { noReplyTrigger: true });
    plugin.onMessageComplete(context);
    expect(scheduleForGroup).toHaveBeenCalledWith('1', '456');
  });

  it('schedules when trigger word in message matches group preference', async () => {
    const { plugin, scheduleForGroup } = await setupPlugin({});
    const context = makeGroupHookContext('say hello please', { noReplyTrigger: true });
    plugin.onMessageComplete(context);
    expect(scheduleForGroup).toHaveBeenCalledWith('1', '456');
  });

  it('does not schedule when no trigger word and accumulator below threshold', async () => {
    const { plugin, scheduleForGroup } = await setupPlugin({});
    const context = makeGroupHookContext('no trigger word here', { noReplyTrigger: true });
    plugin.onMessageComplete(context);
    expect(scheduleForGroup).not.toHaveBeenCalled();
  });

  it('schedules when no trigger word and accumulator reaches threshold', async () => {
    const scheduleForGroup = mock(() => {});
    const container = getContainer();
    const promptManager = new PromptManager();
    promptManager.registerTemplate({ name: 'acg.trigger', namespace: 'preference', content: 'rareword' });
    container.registerInstance(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
      { setGroupConfig: () => {}, setAnalysisProvider: () => {}, scheduleForGroup },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.THREAD_SERVICE, { getActiveThread: () => null }, { allowOverride: true });
    container.registerInstance(DITokens.PROMPT_MANAGER, promptManager, { allowOverride: true });

    const plugin = new ProactiveConversationPlugin({
      name: 'proactiveConversation',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      { api: {} as never, events: {} as never },
      { name: 'proactiveConversation', enabled: true, config: { groups: [{ groupId: '1', preferenceKey: 'acg' }] } },
    );
    await plugin.onInit?.();

    const context = makeGroupHookContext('no trigger', { noReplyTrigger: true });
    for (let i = 0; i < 29; i++) {
      plugin.onMessageComplete(context);
    }
    expect(scheduleForGroup).not.toHaveBeenCalled();
    plugin.onMessageComplete(context);
    expect(scheduleForGroup).toHaveBeenCalledWith('1', '456', true);
  });
});
