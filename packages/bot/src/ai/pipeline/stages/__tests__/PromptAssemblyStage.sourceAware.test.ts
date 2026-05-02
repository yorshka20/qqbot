import 'reflect-metadata';
import { describe, expect, it, mock } from 'bun:test';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import type { ReplyPipelineContext } from '../../ReplyPipelineContext';
import { PromptAssemblyStage } from '../PromptAssemblyStage';

function makeContext(source: string): ReplyPipelineContext {
  const metadata = new HookMetadataMap();
  const hookContext: HookContext = {
    message: {
      id: '1',
      type: 'message',
      timestamp: Date.now(),
      protocol: 'milky',
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
  };
  return {
    hookContext,
    taskResults: new Map(),
    referencedMessage: null,
    userMessageOverride: undefined,
    messageImages: [],
    taskResultImages: [],
    taskResultsSummary: '',
    historyEntries: [],
    sessionId: 'test-session',
    episodeKey: 'ep-1',
    memoryContextText: '',
    retrievedConversationSection: '',
    providerName: undefined,
    userMessage: 'hello',
    selectedProviderName: undefined,
    providerHasVision: false,
    effectiveNativeSearchEnabled: false,
    toolDefinitions: [],
    toolUsageInstructions: '',
    messages: [],
    genOptions: null,
    responseText: '',
    actualProvider: undefined,
    interrupted: false,
  } as unknown as ReplyPipelineContext;
}

/** Minimal promptManager mock for the user_frame render in PromptAssemblyStage. */
const mockPromptManager = {
  render: mock((name: string, vars?: Record<string, string>) => vars?.userMessage ?? ''),
  renderBasePrompt: mock(() => 'base'),
} as any;

/**
 * Build a mock PromptInjectionRegistry that returns scene fragment containing
 * the template name so tests can assert on which scene was rendered.
 */
function makeRegistry(source: string) {
  const sceneFragment = `scene-for-${source}`;
  return {
    gatherByLayer: mock(async () => ({
      baseline: [{ producerName: 'baseline', fragment: 'base-system-prompt' }],
      scene: [{ producerName: 'scene', fragment: sceneFragment }],
      runtime: [],
      tool: [],
    })),
  } as any;
}

describe('PromptAssemblyStage source-aware scene template', () => {
  it('renders scenes.qq-private.zh.scene for qq-private source (via SceneProducer in registry)', async () => {
    const registry = makeRegistry('qq-private');
    const stage = new PromptAssemblyStage(registry, mockPromptManager, {} as any);
    const ctx = makeContext('qq-private');

    await stage.execute(ctx);

    expect(registry.gatherByLayer).toHaveBeenCalledWith(expect.objectContaining({ source: 'qq-private' }));
    // baseSystem should contain the baseline fragment
    expect(ctx.messages.length).toBeGreaterThan(0);
  });

  it('renders scenes.avatar-cmd.zh.scene for avatar-cmd source (via SceneProducer in registry)', async () => {
    const registry = makeRegistry('avatar-cmd');
    const stage = new PromptAssemblyStage(registry, mockPromptManager, {} as any);
    const ctx = makeContext('avatar-cmd');

    await stage.execute(ctx);

    expect(registry.gatherByLayer).toHaveBeenCalledWith(expect.objectContaining({ source: 'avatar-cmd' }));
    expect(ctx.messages.length).toBeGreaterThan(0);
  });

  it('produces 2 system messages (baseSystem + sceneSystem) when registry returns baseline and scene', async () => {
    const registry = makeRegistry('qq-private');
    const stage = new PromptAssemblyStage(registry, mockPromptManager, {} as any);
    const ctx = makeContext('qq-private');

    await stage.execute(ctx);

    // buildNormalMessages always produces at least 2 system messages + 1 user message
    const systemMessages = ctx.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(2);
    expect(systemMessages[0].content).toBe('base-system-prompt');
    expect(systemMessages[1].content).toBe('scene-for-qq-private');
  });
});
