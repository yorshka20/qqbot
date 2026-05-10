import { describe, expect, it } from 'bun:test';
import type { AIService } from '@/ai/AIService';
import { ReplySystem } from '@/conversation/systems/ReplySystem';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';

function makeContext(opts: { message: string; hasReply?: boolean; hasCommand?: boolean }): HookContext {
  const metadata = new HookMetadataMap();
  return {
    message: {
      id: '1',
      type: 'message',
      timestamp: Date.now(),
      protocol: 'milky',
      userId: 1,
      groupId: 2,
      messageType: 'group',
      message: opts.message,
      segments: [],
    },
    context: {
      userMessage: opts.message,
      history: [],
      userId: 1,
      groupId: 2,
      messageType: 'group',
      metadata: new Map(),
    },
    metadata,
    source: 'qq-private' as const,
    ...(opts.hasReply ? { reply: { source: 'ai', segments: [{ type: 'text', data: { text: 'r' } }] } } : {}),
    ...(opts.hasCommand ? { command: { name: 'help', args: [] } } : {}),
  } as HookContext;
}

describe('ReplySystem', () => {
  it('calls generateReplyWithSkills for normal messages', async () => {
    const calls: HookContext[] = [];
    const aiService = {
      generateReplyWithSkills: async (ctx: HookContext) => {
        calls.push(ctx);
      },
    } as unknown as AIService;

    const system = new ReplySystem(aiService);
    const context = makeContext({ message: 'hello' });

    await system.execute(context);

    expect(calls.length).toBe(1);
    expect(calls[0].message.message).toBe('hello');
  });

  it('skips execution when context has reply', async () => {
    const calls: HookContext[] = [];
    const aiService = {
      generateReplyWithSkills: async (ctx: HookContext) => {
        calls.push(ctx);
      },
    } as unknown as AIService;

    const system = new ReplySystem(aiService);
    const context = makeContext({ message: 'hi', hasReply: true });

    await system.execute(context);

    expect(calls.length).toBe(0);
  });

  it('skips execution when context has command', async () => {
    const calls: HookContext[] = [];
    const aiService = {
      generateReplyWithSkills: async (ctx: HookContext) => {
        calls.push(ctx);
      },
    } as unknown as AIService;

    const system = new ReplySystem(aiService);
    const context = makeContext({ message: '/help', hasCommand: true });

    await system.execute(context);

    expect(calls.length).toBe(0);
  });
});
