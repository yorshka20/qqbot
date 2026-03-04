import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import type { PromptTemplate } from '@/ai/prompt/PromptManager';
import { PromptManager } from '@/ai/prompt/PromptManager';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { WhitelistPlugin } from './WhitelistPlugin';

function makeHookContext(messageText: string): HookContext {
  const metadata = new HookMetadataMap();
  metadata.set('botSelfId', '123');
  return {
    message: {
      id: 'm1',
      type: 'message',
      timestamp: Date.now(),
      protocol: 'milky',
      userId: 456,
      groupId: 1,
      messageType: 'group',
      message: messageText,
      segments: [],
    },
    context: {
      userMessage: messageText,
      history: [],
      userId: 456,
      groupId: 1,
      messageType: 'group',
      metadata: new Map(),
    },
    metadata,
  };
}

describe('WhitelistPlugin wake-word flow', () => {
  afterEach(() => {
    getContainer().clear();
  });

  it('allows wake-word messages to enter processing without @bot', async () => {
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
      {
        getGroupPreferenceKeys: (groupId: string) => (groupId === '1' ? ['acg'] : []),
      },
      { allowOverride: true },
    );
    container.registerInstance(
      DITokens.THREAD_SERVICE,
      {
        hasActiveThread: () => false,
      },
      { allowOverride: true },
    );

    const plugin = new WhitelistPlugin({
      name: 'whitelist',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      {
        api: {} as never,
        events: {} as never,
        bot: { getConfig: () => ({}) as never },
      },
      {
        name: 'whitelist',
        enabled: true,
        config: { groupIds: ['1'] },
      },
    );
    await plugin.onInit?.();

    const context = makeHookContext('please wakebot now');
    const result = plugin.onMessagePreprocess(context);

    expect(result).toBe(true);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('triggeredByWakeWord')).toBe(true);
    expect(context.metadata.get('contextMode')).toBe('normal');
  });
});
