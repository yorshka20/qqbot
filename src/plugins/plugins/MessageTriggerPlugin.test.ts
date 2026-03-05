import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import type { PromptTemplate } from '@/ai/prompt/PromptManager';
import { PromptManager } from '@/ai/prompt/PromptManager';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { MessageTriggerPlugin } from './MessageTriggerPlugin';

function makeHookContext(opts: {
  messageText: string;
  messageType?: 'private' | 'group';
  userId?: number;
  groupId?: number;
  botSelfId?: string;
  replyTrigger?: 'at' | 'reaction';
  segments?: Array<{ type: string; data?: Record<string, unknown> }>;
}): HookContext {
  const {
    messageText,
    messageType = 'group',
    userId = 456,
    groupId = 1,
    botSelfId = '123',
    replyTrigger,
    segments = [],
  } = opts;
  const metadata = new HookMetadataMap();
  metadata.set('botSelfId', botSelfId);
  if (replyTrigger) {
    metadata.set('replyTrigger', replyTrigger);
  }
  return {
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
  };
}

describe('MessageTriggerPlugin', () => {
  afterEach(() => {
    getContainer().clear();
  });

  async function initPlugin(config: { wakeWords?: string[]; providerNamesAsTrigger?: boolean } = {}) {
    const container = getContainer();
    const promptManager = new PromptManager();
    container.registerInstance(DITokens.PROMPT_MANAGER, promptManager, { allowOverride: true });
    container.registerInstance(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
      { getGroupPreferenceKeys: () => [] },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.THREAD_SERVICE, { hasActiveThread: () => false }, { allowOverride: true });

    const plugin = new MessageTriggerPlugin({
      name: 'messageTrigger',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      {
        api: {} as never,
        events: {} as never,
        bot: { getConfig: () => ({}) as never },
      },
      { name: 'messageTrigger', enabled: true, config },
    );
    await plugin.onInit?.();
    return plugin;
  }

  it('sets postProcessOnly for bot own messages', async () => {
    const plugin = await initPlugin();
    const context = makeHookContext({ messageText: 'hello', userId: 123, botSelfId: '123' });
    plugin.onMessagePreprocess(context);
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
    plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
  });

  it('allows group message when wake word in config is present and sets replyTriggerType', async () => {
    const plugin = await initPlugin({ wakeWords: ['wakebot'] });
    const context = makeHookContext({ messageText: 'please wakebot now' });
    plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('replyTriggerType')).toBe('wakeWordConfig');
    expect(context.metadata.get('contextMode')).toBe('normal');
  });

  it('allows group message when message starts with provider name (space) and sets replyTriggerType', async () => {
    const plugin = await initPlugin({ providerNamesAsTrigger: true });
    const context = makeHookContext({ messageText: 'claude 你好' });
    plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('replyTriggerType')).toBe('providerName');
    expect(context.metadata.get('contextMode')).toBe('normal');
  });

  it('allows group message when message starts with provider name (colon)', async () => {
    const plugin = await initPlugin({ providerNamesAsTrigger: true });
    const context = makeHookContext({ messageText: 'deepseek: 写一段代码' });
    plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('replyTriggerType')).toBe('providerName');
  });

  it('sets postProcessOnly when no trigger matched (group)', async () => {
    const plugin = await initPlugin();
    const context = makeHookContext({ messageText: 'random message without trigger' });
    plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBe(true);
    expect(context.metadata.get('replyTriggerType')).toBeUndefined();
  });

  it('sets replyTriggerType when replyTrigger is reaction', async () => {
    const plugin = await initPlugin();
    const context = makeHookContext({ messageText: 'hello', replyTrigger: 'reaction' });
    plugin.onMessagePreprocess(context);
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
    plugin.onMessagePreprocess(context);
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
      { getGroupPreferenceKeys: (groupId: string) => (groupId === '1' ? ['acg'] : []) },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.THREAD_SERVICE, { hasActiveThread: () => false }, { allowOverride: true });

    const plugin = new MessageTriggerPlugin({
      name: 'messageTrigger',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      {
        api: {} as never,
        events: {} as never,
        bot: { getConfig: () => ({}) as never },
      },
      { name: 'messageTrigger', enabled: true, config: {} },
    );
    await plugin.onInit?.();

    const context = makeHookContext({ messageText: 'please wakebot now', groupId: 1 });
    plugin.onMessagePreprocess(context);
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
      { getGroupPreferenceKeys: (groupId: string) => (groupId === '1' ? ['acg'] : []) },
      { allowOverride: true },
    );
    container.registerInstance(DITokens.THREAD_SERVICE, { hasActiveThread: () => false }, { allowOverride: true });

    const plugin = new MessageTriggerPlugin({
      name: 'messageTrigger',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      {
        api: {} as never,
        events: {} as never,
        bot: { getConfig: () => ({}) as never },
      },
      { name: 'messageTrigger', enabled: true, config: { wakeWords: ['wakebot'] } },
    );
    await plugin.onInit?.();

    const context = makeHookContext({ messageText: 'please wakebot now', groupId: 1 });
    plugin.onMessagePreprocess(context);
    expect(context.metadata.get('replyTriggerType')).toBe('wakeWordPreference');
  });

  it('does not treat provider prefix as trigger when providerNamesAsTrigger is false', async () => {
    const plugin = await initPlugin({ providerNamesAsTrigger: false });
    const context = makeHookContext({ messageText: 'claude 你好' });
    plugin.onMessagePreprocess(context);
    expect(context.metadata.get('postProcessOnly')).toBe(true);
    expect(context.metadata.get('replyTriggerType')).toBeUndefined();
  });
});
