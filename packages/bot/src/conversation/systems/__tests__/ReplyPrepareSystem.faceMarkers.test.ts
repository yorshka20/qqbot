import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getReply } from '@/context/HookContextHelpers';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext, ReplyContent } from '@/hooks/types';
import type { MessageSegment } from '@/message/types';
import { registerProtocol, unregisterProtocol } from '@/protocol/ProtocolRegistry';
import { ReplyPrepareSystem } from '../ReplyPrepareSystem';

const TEST_PROTOCOL = 'milky';

function makeContext(segments: MessageSegment[]): HookContext {
  const reply: ReplyContent = { source: 'ai', segments };
  return {
    message: {
      id: '1',
      type: 'message',
      timestamp: Date.now(),
      protocol: TEST_PROTOCOL,
      userId: 1,
      groupId: 10000001,
      messageType: 'group',
      message: '',
      segments: [],
    },
    context: {
      userMessage: '',
      history: [],
      userId: 1,
      groupId: 10000001,
      messageType: 'group',
      metadata: new Map(),
    },
    source: 'qq-group',
    metadata: new HookMetadataMap(),
    reply,
  } as unknown as HookContext;
}

describe('ReplyPrepareSystem face markers', () => {
  let system: ReplyPrepareSystem;

  beforeEach(() => {
    registerProtocol(TEST_PROTOCOL, { adapter: { supportsForwardMessage: () => false } as never });
    system = new ReplyPrepareSystem();
  });

  afterEach(() => {
    unregisterProtocol(TEST_PROTOCOL);
  });

  it('expands a marker in the reply text into a face segment', async () => {
    const ctx = makeContext([{ type: 'text', data: { text: '确实[表情:笑哭]' } }]);
    await system.execute(ctx);
    expect(ctx.reply?.segments).toEqual([
      { type: 'text', data: { text: '确实' } },
      { type: 'face', data: { id: '182' } },
    ]);
  });

  it('keeps the face in the text that gets persisted as history', async () => {
    const ctx = makeContext([{ type: 'text', data: { text: '确实[表情:笑哭]' } }]);
    await system.execute(ctx);
    expect(getReply(ctx)).toBe('确实[表情:笑哭]');
  });

  it('leaves non-text segments untouched', async () => {
    const ctx = makeContext([
      { type: 'image', data: { uri: 'file:///tmp/a.png' } },
      { type: 'text', data: { text: '看这个[表情:头秃]' } },
    ]);
    await system.execute(ctx);
    expect(ctx.reply?.segments[0]).toEqual({ type: 'image', data: { uri: 'file:///tmp/a.png' } });
    expect(ctx.reply?.segments[2]).toEqual({ type: 'face', data: { id: '267' } });
  });

  it('drops a marker the table cannot resolve instead of sending it as text', async () => {
    const ctx = makeContext([{ type: 'text', data: { text: '好耶[表情:开心到起飞]' } }]);
    await system.execute(ctx);
    expect(ctx.reply?.segments).toEqual([{ type: 'text', data: { text: '好耶' } }]);
  });

  it('still strips leaked tool call blocks alongside the expansion', async () => {
    const ctx = makeContext([
      { type: 'text', data: { text: '答案是 42<tool_call>{"name":"x"}</tool_call>[表情:赞]' } },
    ]);
    await system.execute(ctx);
    expect(ctx.reply?.segments).toEqual([
      { type: 'text', data: { text: '答案是 42' } },
      { type: 'face', data: { id: '76' } },
    ]);
  });
});
