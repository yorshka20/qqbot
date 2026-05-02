import 'reflect-metadata';
import { describe, expect, it, mock } from 'bun:test';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import type { PromptInjection } from '@/conversation/promptInjection/types';
import type { ReplyPipelineContext } from '../../ReplyPipelineContext';
import { PromptAssemblyStage } from '../PromptAssemblyStage';

/** Minimal promptManager mock for the user_frame render in PromptAssemblyStage. */
const mockPromptManager = {
  render: mock((name: string, vars?: Record<string, string>) => vars?.userMessage ?? ''),
  renderBasePrompt: mock(() => 'base'),
} as any;

function makeContext(source = 'qq-private'): ReplyPipelineContext {
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

function makeInj(producerName: string, fragment: string, priority?: number): PromptInjection {
  return { producerName, fragment, priority };
}

describe('PromptAssemblyStage producer-driven', () => {
  it('test 1: one fragment per layer → baseSystem=baseline, sceneSystem=scene+runtime+tool joined', async () => {
    const registry = {
      gatherByLayer: mock(async () => ({
        baseline: [makeInj('baseline', 'BASE')],
        scene: [makeInj('scene', 'SCENE')],
        runtime: [makeInj('runtime', 'RUNTIME')],
        tool: [makeInj('tool-instruct', 'TOOL')],
      })),
    } as any;
    const stage = new PromptAssemblyStage(registry, mockPromptManager, {} as any);
    const ctx = makeContext();

    await stage.execute(ctx);

    const systemMessages = ctx.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(2);
    expect(systemMessages[0].content).toBe('BASE');
    expect(systemMessages[1].content).toBe('SCENE\n\nRUNTIME\n\nTOOL');
  });

  it('test 2: baseline + 2 runtime fragments (priority 10 and 60) → sceneSystem contains them in priority order', async () => {
    const registry = {
      gatherByLayer: mock(async () => ({
        baseline: [makeInj('baseline', 'BASE')],
        scene: [makeInj('scene', 'SCENE')],
        runtime: [
          makeInj('persona-stable', 'STABLE', 10),
          makeInj('persona-volatile', 'VOLATILE', 60),
        ],
        tool: [],
      })),
    } as any;
    const stage = new PromptAssemblyStage(registry, mockPromptManager, {} as any);
    const ctx = makeContext();

    await stage.execute(ctx);

    const systemMessages = ctx.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(2);
    // Scene first, then runtime in priority order (already sorted by registry)
    expect(systemMessages[1].content).toBe('SCENE\n\nSTABLE\n\nVOLATILE');
  });

  it('test 3: empty tool layer → no trailing empty line in sceneSystem', async () => {
    const registry = {
      gatherByLayer: mock(async () => ({
        baseline: [makeInj('baseline', 'BASE')],
        scene: [makeInj('scene', 'SCENE')],
        runtime: [makeInj('runtime', 'RUNTIME')],
        tool: [],
      })),
    } as any;
    const stage = new PromptAssemblyStage(registry, mockPromptManager, {} as any);
    const ctx = makeContext();

    await stage.execute(ctx);

    const systemMessages = ctx.messages.filter((m) => m.role === 'system');
    expect(systemMessages[1].content).toBe('SCENE\n\nRUNTIME');
    expect(systemMessages[1].content).not.toMatch(/\n\n$/);
  });

  it('test 4: message array has system count = 2', async () => {
    const registry = {
      gatherByLayer: mock(async () => ({
        baseline: [makeInj('baseline', 'BASE')],
        scene: [makeInj('scene', 'SCENE')],
        runtime: [],
        tool: [],
      })),
    } as any;
    const stage = new PromptAssemblyStage(registry, mockPromptManager, {} as any);
    const ctx = makeContext();

    await stage.execute(ctx);

    const systemMessages = ctx.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(2);
  });
});
