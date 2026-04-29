import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import type { PromptTemplate } from '@/ai/prompt/PromptManager';
import { PromptManager } from '@/ai/prompt/PromptManager';
import { ProviderRouter } from '@/ai/routing/ProviderRouter';
import { CommandBuilder } from '@/command/CommandBuilder';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { MessageTriggerPlugin } from '../MessageTriggerPlugin';

/** Creates a ProviderRouter backed by a mock AIManager where all known providers are available. */
function createMockProviderRouter(): ProviderRouter {
  const mockAIManager = {
    getProviderForCapability: () => ({ isAvailable: () => true }),
  } as unknown as import('@/ai/AIManager').AIManager;
  return new ProviderRouter(mockAIManager);
}

/** Creates a mock LLMService whose generateLite() returns plain "true" or "false" for prefix-invitation check. */
function createMockLLMServiceForPrefixCheck(shouldReply: boolean) {
  return {
    generateLite: async () => ({ text: shouldReply ? 'true' : 'false' }),
  };
}

/** Mock Config with optional taskProviders for tests. */
function createMockConfig(taskProviders?: { lite?: string; liteModel?: string }) {
  return {
    getAIConfig: () => (taskProviders !== undefined ? { taskProviders } : undefined),
  };
}

function makeHookContext(opts: {
  messageText: string;
  messageType?: 'private' | 'group';
  userId?: number;
  groupId?: number;
  botSelfId?: string;
  replyTrigger?: 'at' | 'reaction';
  segments?: Array<{ type: string; data?: Record<string, unknown> }>;
  command?: { name: string; args: string[] };
}): HookContext {
  const {
    messageText,
    messageType = 'group',
    userId = 456,
    groupId = 1,
    botSelfId = '123',
    replyTrigger,
    segments = [],
    command: commandOpt,
  } = opts;
  const command = commandOpt ? CommandBuilder.build(commandOpt.name, commandOpt.args) : undefined;
  const metadata = new HookMetadataMap();
  metadata.set('botSelfId', botSelfId);
  if (replyTrigger) {
    metadata.set('replyTrigger', replyTrigger);
  }
  return {
    command,
    message: {
      id: 'm1',
      type: 'message',
      timestamp: Date.now(),
      protocol: 'milky',
      userId,
      groupId,
      messageType,
      message: messageText,
      segments,
    },
    context: {
      userMessage: messageText,
      history: [],
      userId,
      groupId,
      messageType,
      metadata: new Map(),
    },
    metadata,
    source: (messageType === 'private' ? 'qq-private' : 'qq-group') as import('@/conversation/sources').MessageSource,
  };
}

describe('MessageTriggerPlugin', () => {
  afterEach(() => {
    getContainer().clear();
  });

  /** Helper to init plugin with subagent trigger support. Returns mocked sendFromContext calls. */
  async function initPluginWithSubAgent(opts: {
    wakeWords?: string[];
    preferenceKeys?: string[];
    preferenceWord?: string;
    subAgentKeyword: string;
  }) {
    const container = getContainer();
    const promptManager = new PromptManager();

    // Register subagent keyword template
    promptManager.registerTemplate({
      name: 'subagent.test_agent.keywords',
      namespace: 'subagent.test_agent',
      content: opts.subAgentKeyword,
    });
    promptManager.registerTemplate({
      name: 'subagent.test_agent.task',
      namespace: 'subagent.test_agent',
      content: 'Task: {{message}}',
    });

    // Register preference trigger template if provided
    if (opts.preferenceWord) {
      promptManager.registerTemplate({
        name: 'pref.trigger',
        namespace: 'preference',
        content: opts.preferenceWord,
      });
    }

    const sentMessages: string[] = [];
    const mockMessageAPI = {
      sendFromContext: async (segments: unknown) => {
        const text = (segments as Array<{ data?: { text?: string } }>)[0]?.data?.text ?? '';
        sentMessages.push(text);
        return { message_seq: 999, message_id: 999 };
      },
      sendForwardFromContext: async () => ({ message_seq: 0, message_id: 0 }),
    };

    container.registerInstance(DITokens.PROMPT_MANAGER, promptManager, { allowOverride: true });
    container.registerInstance(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
      {
        getGroupPreferenceKeys: (gid: string) => (gid === '1' && opts.preferenceKeys ? opts.preferenceKeys : []),
        isGroupSuppressed: () => false,
      },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.THREAD_SERVICE, { hasActiveThread: () => false }, { allowOverride: true });
    container.registerInstance(DITokens.LLM_SERVICE, createMockLLMServiceForPrefixCheck(true), { allowOverride: true });
    container.registerInstance(
      DITokens.CONFIG,
      {
        getAIConfig: () => undefined,
        getEnabledProtocols: () => [{ name: 'milky' }],
        getBotUserId: () => 123,
        getPluginConfig: () => undefined,
      },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.PROVIDER_ROUTER, createMockProviderRouter(), { allowOverride: true });
    container.registerInstance(
      DITokens.AI_SERVICE,
      { runSubAgent: async () => 'result', processReplyMaybeCard: async () => null },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.MESSAGE_API, mockMessageAPI, { allowOverride: true });
    container.registerInstance(
      DITokens.CONVERSATION_CONFIG_SERVICE,
      { getUseForwardMsg: async () => false },
      { allowOverride: true },
    );

    const plugin = new MessageTriggerPlugin({ name: 'messageTrigger', version: 'test', description: 'test' });
    plugin.loadConfig(
      { api: {} as never, events: {} as never },
      {
        name: 'messageTrigger',
        enabled: true,
        config: {
          wakeWords: opts.wakeWords,
          subAgentTriggers: [{ presetKey: 'test_agent', cooldownMs: 0 }],
        },
      },
    );
    await plugin.onInit?.();
    return { plugin, sentMessages };
  }

  async function initPlugin(config: { wakeWords?: string[] } = {}) {
    const container = getContainer();
    const promptManager = new PromptManager();

    container.registerInstance(DITokens.PROMPT_MANAGER, promptManager, { allowOverride: true });
    container.registerInstance(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
      { getGroupPreferenceKeys: () => [], isGroupSuppressed: () => false },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.THREAD_SERVICE, { hasActiveThread: () => false }, { allowOverride: true });
    container.registerInstance(DITokens.LLM_SERVICE, createMockLLMServiceForPrefixCheck(true), { allowOverride: true });
    container.registerInstance(DITokens.CONFIG, createMockConfig(), { allowOverride: true });
    container.registerInstance(DITokens.PROVIDER_ROUTER, createMockProviderRouter(), { allowOverride: true });

    const plugin = new MessageTriggerPlugin({
      name: 'messageTrigger',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      {
        api: {} as never,
        events: {} as never,
      },
      { name: 'messageTrigger', enabled: true, config },
    );
    await plugin.onInit?.();
    return plugin;
  }

  it('does not set replyTriggerType when postProcessOnly already set (e.g. by WhitelistPlugin)', async () => {
    const plugin = await initPlugin({ wakeWords: ['wakebot'] });
    const context = makeHookContext({ messageText: 'wakebot hello', groupId: 1 });
    context.metadata.set('postProcessOnly', true);
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBe(true);
    expect(context.metadata.get('replyTriggerType')).toBeUndefined();
  });

  it('sets postProcessOnly for bot own messages', async () => {
    const plugin = await initPlugin();
    const context = makeHookContext({ messageText: 'hello', userId: 123, botSelfId: '123' });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBe(true);
  });

  it('does not set postProcessOnly for private messages', async () => {
    const plugin = await initPlugin();
    const context = makeHookContext({
      messageText: 'hello',
      messageType: 'private',
      userId: 456,
      groupId: undefined as unknown as number,
    });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
  });

  it('allows group message when wake word in config is present and sets replyTriggerType', async () => {
    const plugin = await initPlugin({ wakeWords: ['wakebot'] });
    const context = makeHookContext({ messageText: 'please wakebot now' });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('replyTriggerType')).toBe('wakeWordConfig');
    expect(context.metadata.get('contextMode')).toBe('normal');
  });

  it('allows group message when message starts with provider name (space) and sets replyTriggerType', async () => {
    const plugin = await initPlugin();
    const context = makeHookContext({ messageText: 'claude 你好' });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('replyTriggerType')).toBe('providerName');
    expect(context.metadata.get('contextMode')).toBe('normal');
  });

  it('allows group message when message starts with provider name (colon)', async () => {
    const plugin = await initPlugin();
    const context = makeHookContext({ messageText: 'deepseek: 写一段代码' });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('replyTriggerType')).toBe('providerName');
  });

  it('sets postProcessOnly when no trigger matched (group)', async () => {
    const plugin = await initPlugin();
    const context = makeHookContext({ messageText: 'random message without trigger' });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBe(true);
    expect(context.metadata.get('replyTriggerType')).toBeUndefined();
  });

  it('does not set postProcessOnly when context.command is set (command handled by CommandSystem)', async () => {
    const plugin = await initPlugin();
    const context = makeHookContext({
      messageText: '/echo',
      groupId: 304077769,
      command: { name: 'echo', args: [] },
    });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('replyTriggerType')).toBeUndefined();
  });

  it('sets replyTriggerType when replyTrigger is reaction', async () => {
    const plugin = await initPlugin();
    const context = makeHookContext({ messageText: 'hello', replyTrigger: 'reaction' });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('replyTriggerType')).toBe('reaction');
  });

  it('sets replyTriggerType when message @bot (segments)', async () => {
    const plugin = await initPlugin();
    const context = makeHookContext({
      messageText: 'hello',
      botSelfId: '123',
      segments: [{ type: 'at', data: { qq: 123 } }],
    });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('replyTriggerType')).toBe('at');
  });

  it('uses group wake words from preference trigger templates and sets replyTriggerType', async () => {
    const container = getContainer();
    const promptManager = new PromptManager();
    const triggerTemplate: PromptTemplate = {
      name: 'acg.trigger',
      content: 'wakebot',
      namespace: 'preference',
    };
    promptManager.registerTemplate(triggerTemplate);
    container.registerInstance(DITokens.PROMPT_MANAGER, promptManager, { allowOverride: true });
    container.registerInstance(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
      { getGroupPreferenceKeys: (groupId: string) => (groupId === '1' ? ['acg'] : []), isGroupSuppressed: () => false },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.THREAD_SERVICE, { hasActiveThread: () => false }, { allowOverride: true });
    container.registerInstance(DITokens.LLM_SERVICE, createMockLLMServiceForPrefixCheck(true), { allowOverride: true });
    container.registerInstance(DITokens.CONFIG, createMockConfig(), { allowOverride: true });
    container.registerInstance(DITokens.PROVIDER_ROUTER, createMockProviderRouter(), { allowOverride: true });

    const plugin = new MessageTriggerPlugin({
      name: 'messageTrigger',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      {
        api: {} as never,
        events: {} as never,
      },
      { name: 'messageTrigger', enabled: true, config: {} },
    );
    await plugin.onInit?.();

    const context = makeHookContext({ messageText: 'please wakebot now', groupId: 1 });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('replyTriggerType')).toBe('wakeWordPreference');
  });

  it('prefers wakeWordPreference over wakeWordConfig when both match', async () => {
    const container = getContainer();
    const promptManager = new PromptManager();
    promptManager.registerTemplate({
      name: 'acg.trigger',
      content: 'wakebot',
      namespace: 'preference',
    });
    container.registerInstance(DITokens.PROMPT_MANAGER, promptManager, { allowOverride: true });
    container.registerInstance(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
      { getGroupPreferenceKeys: (groupId: string) => (groupId === '1' ? ['acg'] : []), isGroupSuppressed: () => false },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.THREAD_SERVICE, { hasActiveThread: () => false }, { allowOverride: true });
    container.registerInstance(DITokens.LLM_SERVICE, createMockLLMServiceForPrefixCheck(true), { allowOverride: true });
    container.registerInstance(DITokens.CONFIG, createMockConfig(), { allowOverride: true });
    container.registerInstance(DITokens.PROVIDER_ROUTER, createMockProviderRouter(), { allowOverride: true });

    const plugin = new MessageTriggerPlugin({
      name: 'messageTrigger',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      {
        api: {} as never,
        events: {} as never,
      },
      { name: 'messageTrigger', enabled: true, config: { wakeWords: ['wakebot'] } },
    );
    await plugin.onInit?.();

    const context = makeHookContext({ messageText: 'please wakebot now', groupId: 1 });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('replyTriggerType')).toBe('wakeWordPreference');
  });

  it('allows provider-name trigger when message has leading [Reply:xxx] (reply to another message)', async () => {
    const plugin = await initPlugin();
    // Format from MilkyMessageSegmentParser.segmentsToText
    const context = makeHookContext({ messageText: '[Reply:12345]claude 你好' });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('replyTriggerType')).toBe('providerName');
  });

  it('allows provider-name trigger when message has leading [Image:xxx]', async () => {
    const plugin = await initPlugin();
    const context = makeHookContext({ messageText: '[Image:resource_abc]deepseek: 写一段代码' });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('replyTriggerType')).toBe('providerName');
  });

  it('allows provider-name trigger when message has multiple leading segments [Reply][Image] text', async () => {
    const plugin = await initPlugin();
    const context = makeHookContext({
      messageText: '[Reply:1][Image:img1] claude 帮我总结',
    });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('replyTriggerType')).toBe('providerName');
  });

  it('allows wake word when message has leading [Reply:xxx]', async () => {
    const plugin = await initPlugin({ wakeWords: ['wakebot'] });
    const context = makeHookContext({ messageText: '[Reply:999]please wakebot now' });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('replyTriggerType')).toBe('wakeWordConfig');
  });

  it('sets inProactiveThread when threadService.hasActiveThread returns true for group', async () => {
    const container = getContainer();
    container.registerInstance(DITokens.PROMPT_MANAGER, new PromptManager(), { allowOverride: true });
    container.registerInstance(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
      { getGroupPreferenceKeys: () => [], isGroupSuppressed: () => false },
      { allowOverride: true },
    );
    container.registerInstance(
      DITokens.THREAD_SERVICE,
      { hasActiveThread: (gid: string) => gid === '1' },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.LLM_SERVICE, createMockLLMServiceForPrefixCheck(true), { allowOverride: true });
    container.registerInstance(DITokens.CONFIG, createMockConfig(), { allowOverride: true });
    container.registerInstance(DITokens.PROVIDER_ROUTER, createMockProviderRouter(), { allowOverride: true });

    const plugin = new MessageTriggerPlugin({
      name: 'messageTrigger',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      { api: {} as never, events: {} as never },
      { name: 'messageTrigger', enabled: true, config: { wakeWords: ['wakebot'] } },
    );
    await plugin.onInit?.();

    const context = makeHookContext({ messageText: 'wakebot hi', groupId: 1 });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('replyTriggerType')).toBe('wakeWordConfig');
    expect(context.metadata.get('inProactiveThread')).toBe(true);
  });

  // --- SubAgent trigger tests ---

  it('subagent keyword fires subagent when no proactive trigger (postProcessOnly set, notification sent)', async () => {
    const { plugin, sentMessages } = await initPluginWithSubAgent({ subAgentKeyword: 'help_keyword' });
    const context = makeHookContext({ messageText: 'please help_keyword with this', groupId: 1 });
    await plugin.onMessagePreprocess(context);

    // Normal reply pipeline should NOT fire
    expect(context.metadata.get('postProcessOnly')).toBe(true);
    expect(context.metadata.get('replyTriggerType')).toBeUndefined();

    // Give fire-and-forget a tick to send the notification
    await new Promise((r) => setTimeout(r, 10));
    expect(sentMessages.some((m) => m.includes('test_agent') || m.includes('⏳'))).toBe(true);
  });

  it('proactive trigger wins: subagent is skipped when wakeWord fires (mutual exclusion)', async () => {
    const { plugin, sentMessages } = await initPluginWithSubAgent({
      wakeWords: ['wakebot'],
      subAgentKeyword: 'help_keyword',
    });
    // Message matches both wakeWord and subagent keyword
    const context = makeHookContext({ messageText: 'wakebot help_keyword please', groupId: 1 });
    await plugin.onMessagePreprocess(context);

    // Normal reply pipeline fires
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('replyTriggerType')).toBe('wakeWordConfig');

    await new Promise((r) => setTimeout(r, 10));
    // Subagent notification should NOT have been sent
    expect(sentMessages.some((m) => m.includes('⏳'))).toBe(false);
  });

  it('proactive preference trigger wins over subagent keyword (mutual exclusion)', async () => {
    const { plugin, sentMessages } = await initPluginWithSubAgent({
      preferenceKeys: ['pref'],
      preferenceWord: 'prefword',
      subAgentKeyword: 'help_keyword',
    });
    const context = makeHookContext({ messageText: 'prefword help_keyword', groupId: 1 });
    await plugin.onMessagePreprocess(context);

    expect(context.metadata.get('replyTriggerType')).toBe('wakeWordPreference');
    await new Promise((r) => setTimeout(r, 10));
    expect(sentMessages.some((m) => m.includes('⏳'))).toBe(false);
  });

  it('subagent is skipped when whitelistDenied (non-whitelisted group)', async () => {
    const { plugin, sentMessages } = await initPluginWithSubAgent({ subAgentKeyword: 'help_keyword' });
    const context = makeHookContext({ messageText: 'help_keyword please', groupId: 1 });
    context.metadata.set('whitelistDenied', true);
    await plugin.onMessagePreprocess(context);

    await new Promise((r) => setTimeout(r, 10));
    expect(sentMessages.some((m) => m.includes('⏳'))).toBe(false);
  });

  it('subagent keyword does not fire when keyword not in message', async () => {
    const { plugin, sentMessages } = await initPluginWithSubAgent({ subAgentKeyword: 'help_keyword' });
    const context = makeHookContext({ messageText: 'unrelated message', groupId: 1 });
    await plugin.onMessagePreprocess(context);

    await new Promise((r) => setTimeout(r, 10));
    expect(sentMessages.some((m) => m.includes('⏳'))).toBe(false);
  });

  it('sets postProcessOnly when prefix-invitation check says no reply (provider-name trigger)', async () => {
    const container = getContainer();
    const promptManager = new PromptManager();
    // Register template so the plugin runs the LLM check path (mock LLMService.generateLite provides the response).
    promptManager.registerTemplate({
      name: 'analysis.prefix_invitation',
      namespace: 'analysis',
      content: '{{messageText}}',
    });
    container.registerInstance(DITokens.PROMPT_MANAGER, promptManager, { allowOverride: true });
    container.registerInstance(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
      { getGroupPreferenceKeys: () => [], isGroupSuppressed: () => false },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.THREAD_SERVICE, { hasActiveThread: () => false }, { allowOverride: true });
    container.registerInstance(DITokens.LLM_SERVICE, createMockLLMServiceForPrefixCheck(false), {
      allowOverride: true,
    });
    container.registerInstance(DITokens.CONFIG, createMockConfig(), { allowOverride: true });
    container.registerInstance(DITokens.PROVIDER_ROUTER, createMockProviderRouter(), { allowOverride: true });

    const plugin = new MessageTriggerPlugin({
      name: 'messageTrigger',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      {
        api: {} as never,
        events: {} as never,
      },
      { name: 'messageTrigger', enabled: true, config: {} },
    );
    await plugin.onInit?.();

    const context = makeHookContext({ messageText: 'claude' });
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBe(true);
    expect(context.metadata.get('replyTriggerType')).toBeUndefined();
  });
});
