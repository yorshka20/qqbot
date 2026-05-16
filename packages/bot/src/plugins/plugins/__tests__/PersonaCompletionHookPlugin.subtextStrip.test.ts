import 'reflect-metadata';

import { describe, expect, it, vi } from 'bun:test';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import type { PersonaService } from '@/persona';
import { PersonaCompletionHookPlugin } from '../PersonaCompletionHookPlugin';

const pluginOpts = { name: 'persona-completion', version: '1.0.0', description: 'test' };

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

function fakePersonaService(enabled: boolean): PersonaService {
  return {
    isEnabled: () => enabled,
    isApplicableSource: () => true,
  } as unknown as PersonaService;
}

function makeContext(overrides: Partial<HookContext> = {}): HookContext {
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
      message: 'test',
      segments: [],
    },
    context: {
      userMessage: 'test',
      history: [],
      userId: 1,
      groupId: 2,
      messageType: 'group',
      metadata: new Map(),
    },
    metadata,
    source: 'qq-private' as const,
    ...overrides,
  } as HookContext;
}

describe('PersonaCompletionHookPlugin onMessageBeforeSend subtext strip', () => {
  it('strips [SUBTEXT:] and [META:] tags from reply segments and stashes values', async () => {
    const plugin = new PersonaCompletionHookPlugin(pluginOpts);
    plugin['enabled'] = true;
    plugin['persona'] = fakePersonaService(true);

    const ctx = makeContext({
      source: 'qq-private',
      reply: {
        source: 'ai',
        segments: [{ type: 'text', data: { text: '回复正文 [SUBTEXT: secret] [META: a, b]' } }],
      },
    });

    const result = await plugin['onMessageBeforeSend'](ctx);
    expect(result).toBe(true);

    // Tags stripped from visible text
    expect((ctx.reply!.segments[0].data as { text: string }).text).not.toContain('secret');
    expect((ctx.reply!.segments[0].data as { text: string }).text).not.toContain('[SUBTEXT:');
    expect((ctx.reply!.segments[0].data as { text: string }).text).not.toContain('[META:');

    // Stashed values
    expect(ctx.metadata.get('replySubtext')).toBe('secret');
    expect(ctx.metadata.get('replyTagsMeta')).toEqual(['a', 'b']);
  });

  it('leaves text unchanged when no tags present', async () => {
    const plugin = new PersonaCompletionHookPlugin(pluginOpts);
    plugin['enabled'] = true;
    plugin['persona'] = fakePersonaService(true);

    const ctx = makeContext({
      source: 'qq-private',
      reply: {
        source: 'ai',
        segments: [{ type: 'text', data: { text: '普通回复' } }],
      },
    });

    const result = await plugin['onMessageBeforeSend'](ctx);
    expect(result).toBe(true);

    expect((ctx.reply!.segments[0].data as { text: string }).text).toBe('普通回复');
    expect(ctx.metadata.get('replySubtext')).toBeUndefined();
    expect(ctx.metadata.get('replyTagsMeta')).toBeUndefined();
  });

  it('does not strip tags when persona is disabled', async () => {
    const plugin = new PersonaCompletionHookPlugin(pluginOpts);
    plugin['enabled'] = true;
    plugin['persona'] = fakePersonaService(false);

    const originalText = '回复 [SUBTEXT: x]';
    const ctx = makeContext({
      source: 'qq-private',
      reply: {
        source: 'ai',
        segments: [{ type: 'text', data: { text: originalText } }],
      },
    });

    const result = await plugin['onMessageBeforeSend'](ctx);
    expect(result).toBe(true);

    expect((ctx.reply!.segments[0].data as { text: string }).text).toBe(originalText);
    expect(ctx.metadata.get('replySubtext')).toBeUndefined();
    expect(ctx.metadata.get('replyTagsMeta')).toBeUndefined();
  });
});
