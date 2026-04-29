import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext, ReplyContent } from '@/hooks/types';
import { registerProtocol, unregisterProtocol } from '@/protocol/ProtocolRegistry';
import { SendSystem } from '../SendSystem';

const TEST_PROTOCOL = 'milky';

function makeReplyContent(): ReplyContent {
  return {
    source: 'ai',
    segments: [{ type: 'text', data: { text: 'hello' } }],
  };
}

function makeContext(
  source: string,
  replyContent?: ReplyContent,
  responseCallback?: (reply: ReplyContent) => void,
): HookContext {
  const metadata = new HookMetadataMap();
  if (responseCallback) {
    metadata.set('responseCallback', responseCallback);
  }
  return {
    message: {
      id: '1',
      type: 'message',
      timestamp: Date.now(),
      protocol: TEST_PROTOCOL,
      userId: 1,
      messageType: 'private',
      message: 'hello',
      segments: [],
    },
    context: {
      userMessage: 'hello',
      history: [],
      userId: 1,
      groupId: 0,
      messageType: 'private',
      metadata: new Map(),
    },
    source: source as HookContext['source'],
    metadata,
    reply: replyContent,
  } as HookContext;
}

describe('SendSystem responseHandler dispatch', () => {
  let sendFromContextMock: ReturnType<typeof mock>;
  let hookExecuteMock: ReturnType<typeof mock>;
  let messageAPI: MessageAPI;
  let hookManager: any;
  let system: SendSystem;

  beforeEach(() => {
    // Register a mock protocol so the send-to-im path doesn't throw
    registerProtocol(TEST_PROTOCOL, {
      adapter: { supportsForwardMessage: () => false } as any,
    });

    sendFromContextMock = mock(() => Promise.resolve({ messageId: 'sent-123' }));
    hookExecuteMock = mock((_hookName: string, _ctx: HookContext) => Promise.resolve(true));

    messageAPI = {
      sendFromContext: sendFromContextMock,
      sendForwardFromContext: mock(() => Promise.resolve({ messageId: 'forward-123' })),
    } as any;

    hookManager = {
      execute: hookExecuteMock,
      addHandler: mock(() => {}),
    };

    system = new SendSystem(messageAPI, hookManager);
  });

  afterEach(() => {
    unregisterProtocol(TEST_PROTOCOL);
  });

  it('qq-private (send-to-im): calls sendFromContext', async () => {
    const ctx = makeContext('qq-private', makeReplyContent());
    await system.execute(ctx);
    expect(sendFromContextMock).toHaveBeenCalledTimes(1);
  });

  it('bilibili-danmaku (discard): does NOT call sendFromContext; fires onMessageBeforeSend + onMessageSent', async () => {
    const ctx = makeContext('bilibili-danmaku', makeReplyContent());
    await system.execute(ctx);

    expect(sendFromContextMock).not.toHaveBeenCalled();

    const hookNames = hookExecuteMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(hookNames).toContain('onMessageBeforeSend');
    expect(hookNames).toContain('onMessageSent');
  });

  it('avatar-cmd (callback): calls responseCallback with reply; does NOT call sendFromContext; fires both hooks', async () => {
    const callbackSpy = mock((_reply: ReplyContent) => {});
    const reply = makeReplyContent();
    const ctx = makeContext('avatar-cmd', reply, callbackSpy);
    // context.reply needs to be set for the callback to fire
    ctx.reply = reply;
    await system.execute(ctx);

    expect(callbackSpy).toHaveBeenCalledTimes(1);
    expect(sendFromContextMock).not.toHaveBeenCalled();

    const hookNames = hookExecuteMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(hookNames).toContain('onMessageBeforeSend');
    expect(hookNames).toContain('onMessageSent');
  });
});
