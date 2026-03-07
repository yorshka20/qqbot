import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { WhitelistPlugin } from './WhitelistPlugin';

function makeHookContext(opts: {
  messageText: string;
  messageType?: 'private' | 'group';
  userId?: number;
  groupId?: number;
  botSelfId?: string;
}): HookContext {
  const { messageText, messageType = 'group', userId = 456, groupId, botSelfId = '123' } = opts;
  const resolvedGroupId = groupId ?? (messageType === 'group' ? 1 : undefined);
  const metadata = new HookMetadataMap();
  metadata.set('botSelfId', botSelfId);
  return {
    message: {
      id: 'm1',
      type: 'message',
      timestamp: Date.now(),
      protocol: 'milky',
      userId,
      groupId: resolvedGroupId,
      messageType,
      message: messageText,
      segments: [],
    },
    context: {
      userMessage: messageText,
      history: [],
      userId,
      groupId: resolvedGroupId,
      messageType,
      metadata: new Map(),
    },
    metadata,
  };
}

describe('WhitelistPlugin access control', () => {
  it('sets postProcessOnly for bot own messages', async () => {
    const plugin = new WhitelistPlugin({
      name: 'whitelist',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      {
        api: {} as never,
        events: {} as never,
      },
      { name: 'whitelist', enabled: true, config: {} },
    );
    await plugin.onInit?.();

    const context = makeHookContext({ messageText: 'hello', userId: 123, botSelfId: '123' });
    plugin.onMessagePreprocess(context);

    expect(context.metadata.get('postProcessOnly')).toBe(true);
  });

  it('sets postProcessOnly when user not in whitelist (private)', async () => {
    const plugin = new WhitelistPlugin({
      name: 'whitelist',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      {
        api: {} as never,
        events: {} as never,
      },
      { name: 'whitelist', enabled: true, config: { userIds: ['999'] } },
    );
    await plugin.onInit?.();

    const context = makeHookContext({
      messageText: 'hello',
      messageType: 'private',
      userId: 456,
      groupId: undefined,
    });
    plugin.onMessagePreprocess(context);

    expect(context.metadata.get('postProcessOnly')).toBe(true);
    expect(context.metadata.get('whitelistUser')).toBeUndefined();
  });

  it('allows private message when user in whitelist', async () => {
    const plugin = new WhitelistPlugin({
      name: 'whitelist',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      {
        api: {} as never,
        events: {} as never,
      },
      { name: 'whitelist', enabled: true, config: { userIds: ['456'] } },
    );
    await plugin.onInit?.();

    const context = makeHookContext({
      messageText: 'hello',
      messageType: 'private',
      userId: 456,
      groupId: undefined,
    });
    plugin.onMessagePreprocess(context);

    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('whitelistUser')).toBe(true);
    expect(context.metadata.get('contextMode')).toBe('normal');
  });

  it('sets postProcessOnly when group not in whitelist', async () => {
    const plugin = new WhitelistPlugin({
      name: 'whitelist',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      {
        api: {} as never,
        events: {} as never,
      },
      { name: 'whitelist', enabled: true, config: { groupIds: ['999'] } },
    );
    await plugin.onInit?.();

    const context = makeHookContext({ messageText: 'hello', groupId: 1 });
    plugin.onMessagePreprocess(context);

    expect(context.metadata.get('postProcessOnly')).toBe(true);
  });

  it('allows group message when group in whitelist', async () => {
    const plugin = new WhitelistPlugin({
      name: 'whitelist',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      {
        api: {} as never,
        events: {} as never,
      },
      { name: 'whitelist', enabled: true, config: { groupIds: ['1'] } },
    );
    await plugin.onInit?.();

    const context = makeHookContext({ messageText: 'hello', groupId: 1 });
    plugin.onMessagePreprocess(context);

    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('whitelistGroup')).toBe(true);
  });

  it('allows all groups when no group whitelist configured', async () => {
    const plugin = new WhitelistPlugin({
      name: 'whitelist',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig(
      {
        api: {} as never,
        events: {} as never,
      },
      { name: 'whitelist', enabled: true, config: {} },
    );
    await plugin.onInit?.();

    const context = makeHookContext({ messageText: 'hello', groupId: 1 });
    plugin.onMessagePreprocess(context);

    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('whitelistGroup')).toBe(true);
  });
});
