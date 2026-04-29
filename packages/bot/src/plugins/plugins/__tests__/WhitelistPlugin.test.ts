import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { WhitelistPlugin } from '../WhitelistPlugin';

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
    source: (messageType === 'private' ? 'qq-private' : 'qq-group') as import('@/conversation/sources').MessageSource,
  };
}

describe('WhitelistPlugin access control', () => {
  it('sets postProcessOnly and whitelistDenied for bot own messages', async () => {
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
    plugin.onMessageReceived(context);

    // Bot own messages: WhitelistPlugin no longer sets postProcessOnly (MessageTriggerPlugin handles that).
    // With no whitelist configured, group is allowed by default.
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('whitelistGroup')).toBe(true);
  });

  it('sets postProcessOnly and whitelistDenied when user not in whitelist (private)', async () => {
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
    plugin.onMessageReceived(context);

    expect(context.metadata.get('postProcessOnly')).toBe(true);
    expect(context.metadata.get('whitelistDenied')).toBe(true);
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
    plugin.onMessageReceived(context);

    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('whitelistDenied')).toBeUndefined();
    expect(context.metadata.get('whitelistUser')).toBe(true);
  });

  it('sets whitelistDenied only when group not in whitelist (RECEIVE only; no postProcessOnly so PREPROCESS runs)', async () => {
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
    plugin.onMessageReceived(context);
    expect(context.metadata.get('whitelistDenied')).toBe(true);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('whitelistGroup')).toBeUndefined();
  });

  it('allows private message when no user whitelist configured (whitelistUser set, no deny)', async () => {
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

    const context = makeHookContext({
      messageText: 'hello',
      messageType: 'private',
      userId: 456,
      groupId: undefined,
    });
    plugin.onMessageReceived(context);

    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('whitelistDenied')).toBeUndefined();
    expect(context.metadata.get('whitelistUser')).toBe(true);
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
    plugin.onMessageReceived(context);

    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('whitelistDenied')).toBeUndefined();
    expect(context.metadata.get('whitelistGroup')).toBe(true);
  });

  it('onMessageReceived does not set postProcessOnly when group in whitelist', async () => {
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
    plugin.onMessageReceived(context);

    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
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
    plugin.onMessageReceived(context);

    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('whitelistDenied')).toBeUndefined();
    expect(context.metadata.get('whitelistGroup')).toBe(true);
  });

  it('allows group when groupIds in config are numbers (normalized to string for lookup)', async () => {
    const plugin = new WhitelistPlugin({
      name: 'whitelist',
      version: 'test',
      description: 'test',
    });
    // Config may have numeric groupIds from JSON; plugin normalizes to string so message.groupId matches
    plugin.loadConfig(
      {
        api: {} as never,
        events: {} as never,
      },
      { name: 'whitelist', enabled: true, config: { groupIds: [304077769] } },
    );
    await plugin.onInit?.();

    const context = makeHookContext({ messageText: '/echo', groupId: 304077769 });
    plugin.onMessageReceived(context);
    expect(context.metadata.get('postProcessOnly')).toBeUndefined();
    expect(context.metadata.get('whitelistDenied')).toBeUndefined();
    expect(context.metadata.get('whitelistGroup')).toBe(true);
  });

  describe('groups config with limited capabilities', () => {
    it('sets whitelistGroupCapabilities when group has capabilities in groups config', async () => {
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
        {
          name: 'whitelist',
          enabled: true,
          config: {
            groups: [{ id: '1', capabilities: ['command', 'reply'] }, { id: '2' }],
          },
        },
      );
      await plugin.onInit?.();

      const context1 = makeHookContext({ messageText: 'hello', groupId: 1 });
      plugin.onMessageReceived(context1);
      expect(context1.metadata.get('whitelistDenied')).toBeUndefined();
      expect(context1.metadata.get('whitelistGroup')).toBe(true);
      expect(context1.metadata.get('whitelistGroupCapabilities')).toEqual(['command', 'reply']);

      const context2 = makeHookContext({ messageText: 'hello', groupId: 2 });
      plugin.onMessageReceived(context2);
      expect(context2.metadata.get('whitelistGroup')).toBe(true);
      expect(context2.metadata.get('whitelistGroupCapabilities')).toBeUndefined();
    });

    it('getGroupCapabilities returns undefined for group not in whitelist', async () => {
      const plugin = new WhitelistPlugin({
        name: 'whitelist',
        version: 'test',
        description: 'test',
      });
      plugin.loadConfig(
        { api: {} as never, events: {} as never },
        { name: 'whitelist', enabled: true, config: { groups: [{ id: '1', capabilities: ['command'] }] } },
      );
      await plugin.onInit?.();

      expect(plugin.getGroupCapabilities('999')).toBeUndefined();
    });

    it('getGroupCapabilities returns capability list for limited group', async () => {
      const plugin = new WhitelistPlugin({
        name: 'whitelist',
        version: 'test',
        description: 'test',
      });
      plugin.loadConfig(
        { api: {} as never, events: {} as never },
        { name: 'whitelist', enabled: true, config: { groups: [{ id: '1', capabilities: ['command'] }] } },
      );
      await plugin.onInit?.();

      expect(plugin.getGroupCapabilities('1')).toEqual(['command']);
    });

    it('getGroupCapabilities returns empty array for full-access group in groups config', async () => {
      const plugin = new WhitelistPlugin({
        name: 'whitelist',
        version: 'test',
        description: 'test',
      });
      plugin.loadConfig(
        { api: {} as never, events: {} as never },
        { name: 'whitelist', enabled: true, config: { groups: [{ id: '1' }] } },
      );
      await plugin.onInit?.();

      expect(plugin.getGroupCapabilities('1')).toEqual([]);
    });
  });

  describe('dynamic whitelist (addGroupToWhitelist / removeGroupFromWhitelist)', () => {
    it('addGroupToWhitelist with capabilities: group allowed and getGroupCapabilities returns those caps', async () => {
      const plugin = new WhitelistPlugin({
        name: 'whitelist',
        version: 'test',
        description: 'test',
      });
      // One other group in config so whitelist is restricted; 123456 only allowed when dynamically added
      plugin.loadConfig(
        { api: {} as never, events: {} as never },
        { name: 'whitelist', enabled: true, config: { groups: [{ id: '1' }] } },
      );
      await plugin.onInit?.();

      plugin.addGroupToWhitelist('123456', ['reply', 'proactive']);

      expect(plugin.getGroupCapabilities('123456')).toEqual(['reply', 'proactive']);
    });

    it('addGroupToWhitelist with capabilities: onMessageReceived sets whitelistGroup and whitelistGroupCapabilities', async () => {
      const plugin = new WhitelistPlugin({
        name: 'whitelist',
        version: 'test',
        description: 'test',
      });
      plugin.loadConfig(
        { api: {} as never, events: {} as never },
        { name: 'whitelist', enabled: true, config: { groups: [{ id: '1' }] } },
      );
      await plugin.onInit?.();

      plugin.addGroupToWhitelist('123456', ['reply', 'proactive']);

      const context = makeHookContext({ messageText: 'hello', groupId: 123456 });
      plugin.onMessageReceived(context);

      expect(context.metadata.get('whitelistDenied')).toBeUndefined();
      expect(context.metadata.get('whitelistGroup')).toBe(true);
      expect(context.metadata.get('whitelistGroupCapabilities')).toEqual(['reply', 'proactive']);
    });

    it('addGroupToWhitelist without capabilities: group has full access (empty array)', async () => {
      const plugin = new WhitelistPlugin({
        name: 'whitelist',
        version: 'test',
        description: 'test',
      });
      plugin.loadConfig(
        { api: {} as never, events: {} as never },
        { name: 'whitelist', enabled: true, config: { groups: [{ id: '1' }] } },
      );
      await plugin.onInit?.();

      plugin.addGroupToWhitelist('999');

      expect(plugin.getGroupCapabilities('999')).toEqual([]);
      const context = makeHookContext({ messageText: 'hi', groupId: 999 });
      plugin.onMessageReceived(context);
      expect(context.metadata.get('whitelistGroup')).toBe(true);
      expect(context.metadata.get('whitelistGroupCapabilities')).toBeUndefined();
    });

    it('removeGroupFromWhitelist: group denied and getGroupCapabilities returns undefined', async () => {
      const plugin = new WhitelistPlugin({
        name: 'whitelist',
        version: 'test',
        description: 'test',
      });
      plugin.loadConfig(
        { api: {} as never, events: {} as never },
        { name: 'whitelist', enabled: true, config: { groups: [{ id: '1' }] } },
      );
      await plugin.onInit?.();

      plugin.addGroupToWhitelist('123456', ['reply', 'proactive']);
      expect(plugin.getGroupCapabilities('123456')).toEqual(['reply', 'proactive']);

      plugin.removeGroupFromWhitelist('123456');

      expect(plugin.getGroupCapabilities('123456')).toBeUndefined();
      const context = makeHookContext({ messageText: 'hello', groupId: 123456 });
      plugin.onMessageReceived(context);
      expect(context.metadata.get('whitelistDenied')).toBe(true);
      expect(context.metadata.get('whitelistGroup')).toBeUndefined();
    });

    it('add after remove: group allowed again with new capabilities', async () => {
      const plugin = new WhitelistPlugin({
        name: 'whitelist',
        version: 'test',
        description: 'test',
      });
      plugin.loadConfig(
        { api: {} as never, events: {} as never },
        { name: 'whitelist', enabled: true, config: { groups: [{ id: '1' }] } },
      );
      await plugin.onInit?.();

      plugin.addGroupToWhitelist('1', ['reply']);
      plugin.removeGroupFromWhitelist('1');
      plugin.addGroupToWhitelist('1', ['reply', 'proactive', 'command']);

      expect(plugin.getGroupCapabilities('1')).toEqual(['reply', 'proactive', 'command']);
      const context = makeHookContext({ messageText: 'hi', groupId: 1 });
      plugin.onMessageReceived(context);
      expect(context.metadata.get('whitelistDenied')).toBeUndefined();
      expect(context.metadata.get('whitelistGroupCapabilities')).toEqual(['reply', 'proactive', 'command']);
    });
  });
});
