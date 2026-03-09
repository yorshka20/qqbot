/**
 * Integration tests: WhitelistPlugin + MessageTriggerPlugin (+ ProactiveConversationPlugin) in pipeline order.
 * Ensures:
 * - Non-whitelist group: whitelistDenied set by WhitelistPlugin (RECEIVE only); Lifecycle skips to COMPLETE after PREPROCESS.
 * - Whitelist group: command and message handling both work (whitelistGroup set, pipeline continues).
 * - Whitelist group + no direct trigger: postProcessOnly set by MessageTrigger; ProactiveConversationPlugin still schedules (only skips on whitelistDenied).
 */
import 'reflect-metadata';

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { PromptManager } from '@/ai/prompt/PromptManager';
import { CommandBuilder } from '@/command/CommandBuilder';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { MessageTriggerPlugin } from '../MessageTriggerPlugin';
import { ProactiveConversationPlugin } from '../ProactiveConversationPlugin';
import { WhitelistPlugin } from '../WhitelistPlugin';

function makeHookContext(opts: {
  messageText: string;
  messageType?: 'private' | 'group';
  userId?: number;
  groupId?: number;
  botSelfId?: string;
  command?: { name: string; args: string[] };
  segments?: Array<{ type: string; data?: Record<string, unknown> }>;
}): HookContext {
  const {
    messageText,
    messageType = 'group',
    userId = 456,
    groupId = 1,
    botSelfId = '123',
    command: commandOpt,
    segments = [],
  } = opts;
  const command = commandOpt ? CommandBuilder.build(commandOpt.name, commandOpt.args) : undefined;
  const metadata = new HookMetadataMap();
  metadata.set('botSelfId', botSelfId);
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
  };
}

async function initWhitelist(config: { groupIds?: string[] | number[] } = {}) {
  const plugin = new WhitelistPlugin({
    name: 'whitelist',
    version: 'test',
    description: 'test',
  });
  plugin.loadConfig({ api: {} as never, events: {} as never }, { name: 'whitelist', enabled: true, config });
  await plugin.onInit?.();
  return plugin;
}

async function initMessageTrigger(config: { wakeWords?: string[] } = {}) {
  const container = getContainer();
  const promptManager = new PromptManager();
  container.registerInstance(DITokens.PROMPT_MANAGER, promptManager, { allowOverride: true });
  container.registerInstance(
    DITokens.PROACTIVE_CONVERSATION_SERVICE,
    { getGroupPreferenceKeys: () => [] },
    { allowOverride: true },
  );
  container.registerInstance(DITokens.THREAD_SERVICE, { hasActiveThread: () => false }, { allowOverride: true });
  container.registerInstance(
    DITokens.LLM_SERVICE,
    { generateLite: async () => ({ text: 'true' }) },
    { allowOverride: true },
  );
  container.registerInstance(DITokens.CONFIG, { getAIConfig: () => undefined }, { allowOverride: true });
  const plugin = new MessageTriggerPlugin({
    name: 'messageTrigger',
    version: 'test',
    description: 'test',
  });
  plugin.loadConfig({ api: {} as never, events: {} as never }, { name: 'messageTrigger', enabled: true, config });
  await plugin.onInit?.();
  return plugin;
}

describe('Whitelist + MessageTrigger integration', () => {
  afterEach(() => {
    getContainer().clear();
  });

  describe('non-whitelist group: whitelistDenied set, pipeline skips to COMPLETE', () => {
    it('sets whitelistDenied so command and message are not processed', async () => {
      const whitelist = await initWhitelist({ groupIds: ['999'] });
      const trigger = await initMessageTrigger();

      const groupId = 1;
      const contextCmd = makeHookContext({
        messageText: '/echo',
        groupId,
        command: { name: 'echo', args: [] },
      });
      const contextMsg = makeHookContext({
        messageText: 'hello',
        groupId,
      });

      whitelist.onMessageReceived(contextCmd);
      expect(contextCmd.metadata.get('whitelistDenied')).toBe(true);
      expect(contextCmd.metadata.get('postProcessOnly')).toBeUndefined();

      await trigger.onMessagePreprocess(contextCmd);
      expect(contextCmd.metadata.get('whitelistDenied')).toBe(true);

      whitelist.onMessageReceived(contextMsg);
      expect(contextMsg.metadata.get('whitelistDenied')).toBe(true);
      expect(contextMsg.metadata.get('postProcessOnly')).toBeUndefined();

      await trigger.onMessagePreprocess(contextMsg);
      expect(contextMsg.metadata.get('whitelistDenied')).toBe(true);
      expect(contextMsg.metadata.get('postProcessOnly')).toBe(true);
    });
  });

  describe('whitelist group: command and message handling work', () => {
    it('command is not blocked (whitelistGroup set, pipeline continues to PROCESS)', async () => {
      const whitelist = await initWhitelist({ groupIds: ['1'] });
      const trigger = await initMessageTrigger();

      const context = makeHookContext({
        messageText: '/echo',
        groupId: 1,
        command: { name: 'echo', args: [] },
      });

      whitelist.onMessageReceived(context);
      expect(context.metadata.get('postProcessOnly')).toBeUndefined();
      expect(context.metadata.get('whitelistDenied')).toBeUndefined();
      expect(context.metadata.get('whitelistGroup')).toBe(true);

      await trigger.onMessagePreprocess(context);
      expect(context.metadata.get('postProcessOnly')).toBeUndefined();
      expect(context.command?.name).toBe('echo');
      expect(context.command?.args).toEqual([]);
    });

    it('message with trigger is not blocked (replyTriggerType set, pipeline can run)', async () => {
      const whitelist = await initWhitelist({ groupIds: ['1'] });
      const trigger = await initMessageTrigger({ wakeWords: ['wakebot'] });

      const context = makeHookContext({
        messageText: 'wakebot 你好',
        groupId: 1,
      });

      whitelist.onMessageReceived(context);
      expect(context.metadata.get('postProcessOnly')).toBeUndefined();
      expect(context.metadata.get('whitelistGroup')).toBe(true);

      await trigger.onMessagePreprocess(context);
      expect(context.metadata.get('postProcessOnly')).toBeUndefined();
      expect(context.metadata.get('replyTriggerType')).toBe('wakeWordConfig');
      expect(context.metadata.get('contextMode')).toBe('normal');
    });

    it('message @bot is not blocked (replyTriggerType at, pipeline can run)', async () => {
      const whitelist = await initWhitelist({ groupIds: ['1'] });
      const trigger = await initMessageTrigger();
      const botSelfId = '123';

      const context = makeHookContext({
        messageText: 'hello',
        groupId: 1,
        botSelfId,
        segments: [{ type: 'at', data: { qq: 123 } }],
      });

      whitelist.onMessageReceived(context);
      expect(context.metadata.get('postProcessOnly')).toBeUndefined();
      expect(context.metadata.get('whitelistGroup')).toBe(true);

      await trigger.onMessagePreprocess(context);
      expect(context.metadata.get('postProcessOnly')).toBeUndefined();
      expect(context.metadata.get('replyTriggerType')).toBe('at');
      expect(context.metadata.get('contextMode')).toBe('normal');
    });
  });

  describe('whitelist group + no trigger: postProcessOnly set, proactive still schedules', () => {
    it('after Whitelist + MessageTrigger, ProactiveConversationPlugin schedules (whitelistDenied false)', async () => {
      const whitelist = await initWhitelist({ groupIds: ['1'] });
      const trigger = await initMessageTrigger();
      const scheduleForGroup = mock(() => {});
      const container = getContainer();
      const promptManager = new PromptManager();
      promptManager.registerTemplate({
        name: 'acg.trigger',
        namespace: 'preference',
        content: 'hello',
      });
      container.registerInstance(DITokens.PROMPT_MANAGER, promptManager, { allowOverride: true });
      container.registerInstance(
        DITokens.PROACTIVE_CONVERSATION_SERVICE,
        { getGroupPreferenceKeys: () => [], setGroupConfig: () => {}, setAnalysisProvider: () => {}, scheduleForGroup },
        { allowOverride: true },
      );
      container.registerInstance(DITokens.THREAD_SERVICE, { getActiveThread: () => null }, { allowOverride: true });

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

      const context = makeHookContext({ messageText: 'say hello please', groupId: 1 });
      whitelist.onMessageReceived(context);
      expect(context.metadata.get('whitelistDenied')).toBeUndefined();
      expect(context.metadata.get('whitelistGroup')).toBe(true);

      await trigger.onMessagePreprocess(context);
      expect(context.metadata.get('postProcessOnly')).toBe(true);
      expect(context.metadata.get('replyTriggerType')).toBeUndefined();

      proactive.onMessageComplete(context);
      expect(scheduleForGroup).toHaveBeenCalled();
    });
  });
});
