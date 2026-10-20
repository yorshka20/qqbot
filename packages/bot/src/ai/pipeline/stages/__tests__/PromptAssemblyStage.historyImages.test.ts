import 'reflect-metadata';
import { describe, expect, it, mock } from 'bun:test';
import type { Config } from '@/core/config';
import { DEFAULT_CHAT_REASONING_EFFORTS } from '@/core/config/types/ai';
import type { ConversationMessageEntry } from '@/conversation/history';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { PromptMessageAssembler } from '../../../prompt/PromptMessageAssembler';
import type { ReplyPipelineContext } from '../../ReplyPipelineContext';
import { PromptAssemblyStage } from '../PromptAssemblyStage';

const NO_AI_CONFIG = {
  getAIConfig: () => undefined,
  getChatReasoningEfforts: () => DEFAULT_CHAT_REASONING_EFFORTS,
} as unknown as Config;

const mockPromptManager = {
  render: mock((_name: string, vars?: Record<string, string>) => vars?.userMessage ?? ''),
  renderBasePrompt: mock(() => 'base'),
  messageAssembler: new PromptMessageAssembler(),
} as any;

const registry = {
  gatherByLayer: mock(async () => ({ baseline: [], scene: [], runtime: [], tool: [] })),
} as any;

/**
 * A history entry whose only handle on its image is a resource_id, so resolving it has to go
 * through `getResourceTempUrl` and nothing can fall back to a URL on the segment.
 */
function entryWithImage(index: number): ConversationMessageEntry {
  return {
    messageId: `msg-${index}`,
    userId: 10000001,
    nickname: '测试用户甲',
    content: `history ${index}`,
    segments: [{ type: 'image', data: { resource_id: `res-${index}` } }],
    isBotReply: false,
    createdAt: new Date(),
  } as ConversationMessageEntry;
}

function makeContext(historyEntries: ConversationMessageEntry[]): ReplyPipelineContext {
  const hookContext: HookContext = {
    message: {
      id: '1',
      type: 'message',
      timestamp: Date.now(),
      protocol: 'milky',
      userId: 10000001,
      messageType: 'private',
      message: 'hello',
      segments: [],
    },
    context: {
      userMessage: 'hello',
      history: [],
      userId: 10000001,
      groupId: 0,
      messageType: 'private',
      metadata: new Map(),
    },
    source: 'qq-private' as HookContext['source'],
    metadata: new HookMetadataMap(),
  };
  return {
    hookContext,
    taskResults: new Map(),
    referencedMessage: null,
    messageImages: [],
    taskResultImages: [],
    historyEntries,
    sessionId: 'test-session',
    episodeKey: 'ep-1',
    memoryContextText: '',
    retrievedConversationSection: '',
    providerHasVision: true,
    effectiveNativeSearchEnabled: false,
    toolDefinitions: [],
    toolUsageInstructions: '',
    messages: [],
    genOptions: null,
    responseText: '',
    interrupted: false,
  } as unknown as ReplyPipelineContext;
}

describe('PromptAssemblyStage history image resolution', () => {
  it('resolves every history entry concurrently rather than one after another', async () => {
    const perCall = 150;
    const getResourceTempUrl = mock(
      () => new Promise<string | null>((resolve) => setTimeout(() => resolve(null), perCall)),
    );
    const stage = new PromptAssemblyStage(registry, mockPromptManager, { getResourceTempUrl } as any, NO_AI_CONFIG);
    const entries = [0, 1, 2, 3].map(entryWithImage);

    const startedAt = Date.now();
    await stage.execute(makeContext(entries));
    const elapsed = Date.now() - startedAt;

    expect(getResourceTempUrl).toHaveBeenCalledTimes(entries.length);
    // Serial resolution would cost entries.length * perCall; concurrent costs about one call.
    expect(elapsed).toBeLessThan(perCall * 2);
  });

  it('keeps the text placeholder for an entry whose resource never resolves', async () => {
    const getResourceTempUrl = mock((resourceId: string) =>
      resourceId === 'res-0' ? new Promise<string | null>(() => {}) : Promise.resolve(null),
    );
    const stage = new PromptAssemblyStage(registry, mockPromptManager, { getResourceTempUrl } as any, NO_AI_CONFIG);
    const ctx = makeContext([0, 1].map(entryWithImage));

    await stage.execute(ctx);

    // The stalled entry must not hold up the prompt, and must still carry its text.
    expect(ctx.messages.length).toBeGreaterThan(0);
    for (const message of ctx.messages) {
      expect(typeof message.content).toBe('string');
    }
    expect(ctx.messages.some((m) => typeof m.content === 'string' && m.content.includes('history 0'))).toBe(true);
  }, 15000);
});
