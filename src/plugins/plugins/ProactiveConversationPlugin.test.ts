import 'reflect-metadata';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { PromptManager } from '@/ai/prompt/PromptManager';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { ProactiveConversationPlugin } from './ProactiveConversationPlugin';

function makeGroupHookContext(messageText: string): HookContext {
  const metadata = new HookMetadataMap();
  metadata.set('botSelfId', '123');
  metadata.set('replyTriggerType', 'wakeWordConfig');
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
});
