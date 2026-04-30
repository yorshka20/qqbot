import 'reflect-metadata';
import { afterEach, describe, expect, it, jest } from 'bun:test';
import type { MessageSource } from '@/conversation/sources';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { PoseLifecyclePlugin } from '../PoseLifecyclePlugin';

function makeHookContext(source: MessageSource): HookContext {
  const metadata = new HookMetadataMap();
  metadata.set('botSelfId', '123');
  metadata.set('sessionId', 's1');
  metadata.set('sessionType', 'user');
  metadata.set('conversationId', 'c1');
  metadata.set('userId', 456);
  metadata.set('groupId', 0);
  metadata.set('senderRole', 'user');
  return {
    message: {
      id: 'm1',
      type: 'message',
      timestamp: Date.now(),
      protocol: 'milky',
      userId: 456,
      groupId: 0,
      messageType: 'private',
      message: 'test',
      segments: [],
    },
    context: {
      userMessage: 'test',
      history: [],
      userId: 456,
      groupId: 0,
      messageType: 'private',
      metadata: new Map(),
    },
    metadata,
    source,
  };
}

describe('PoseLifecyclePlugin', () => {
  let plugin: PoseLifecyclePlugin;
  let mockSetActivity: ReturnType<typeof jest.fn>;

  afterEach(() => {
    getContainer().clear();
  });

  function initPlugin(isActive = true) {
    mockSetActivity = jest.fn();
    const mockAvatar = {
      isActive: () => isActive,
      setActivity: mockSetActivity,
    };

    const container = getContainer();
    container.registerInstance(DITokens.AVATAR_SERVICE, mockAvatar, { allowOverride: true });

    plugin = new PoseLifecyclePlugin({
      name: 'pose-lifecycle',
      version: 'test',
      description: 'test',
    });
    plugin.loadConfig({ api: {} as never, events: {} as never }, { name: 'pose-lifecycle', enabled: true });
  }

  it('onMessagePreprocess with avatar-cmd → setActivity called with {pose:thinking}', async () => {
    initPlugin();
    await plugin.onInit?.();

    const context = makeHookContext('avatar-cmd');
    await plugin.onMessagePreprocess(context);

    expect(mockSetActivity).toHaveBeenCalledWith({ pose: 'thinking' });
  });

  it('onMessageComplete with avatar-cmd → setActivity called with {pose:neutral}', async () => {
    initPlugin();
    await plugin.onInit?.();

    const context = makeHookContext('avatar-cmd');
    await plugin.onMessageComplete(context);

    expect(mockSetActivity).toHaveBeenCalledWith({ pose: 'neutral' });
  });

  it('onError with avatar-cmd → setActivity called with {pose:neutral}', async () => {
    initPlugin();
    await plugin.onInit?.();

    const context = makeHookContext('avatar-cmd');
    await plugin.onError(context);

    expect(mockSetActivity).toHaveBeenCalledWith({ pose: 'neutral' });
  });

  it('qq-private source → setActivity NOT called (poseLifecycle=false)', async () => {
    initPlugin();
    await plugin.onInit?.();

    const context = makeHookContext('qq-private');
    await plugin.onMessagePreprocess(context);

    expect(mockSetActivity).not.toHaveBeenCalled();
  });

  it('avatar.isActive() → false → setActivity NOT called', async () => {
    initPlugin(false);
    await plugin.onInit?.();

    const context = makeHookContext('avatar-cmd');
    await plugin.onMessagePreprocess(context);

    expect(mockSetActivity).not.toHaveBeenCalled();
  });
});
