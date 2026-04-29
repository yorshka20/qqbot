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

describe('PromptAssemblyStage source-aware scene template', () => {
  it('renders scenes.qq-private.zh.scene for qq-private source', async () => {
    const renderMock = mock((name: string, _vars?: Record<string, string>) => `rendered:${name}`);
    const pm = {
      render: renderMock,
      renderBasePrompt: mock(() => 'base-system-prompt'),
    } as any;
    const stage = new PromptAssemblyStage(pm, {} as any);
    const ctx = makeContext('qq-private');

    await stage.execute(ctx);

    const calledNames = renderMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calledNames).toContain('scenes.qq-private.zh.scene');
  });

  it('renders scenes.avatar-cmd.zh.scene for avatar-cmd source', async () => {
    const renderMock = mock((name: string, _vars?: Record<string, string>) => `rendered:${name}`);
    const pm = {
      render: renderMock,
      renderBasePrompt: mock(() => 'base-system-prompt'),
    } as any;
    const stage = new PromptAssemblyStage(pm, {} as any);
    const ctx = makeContext('avatar-cmd');

    await stage.execute(ctx);

    const calledNames = renderMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calledNames).toContain('scenes.avatar-cmd.zh.scene');
  });

  it('falls back to llm.reply.system when scene template render throws', async () => {
    const renderMock = mock((name: string, _vars?: Record<string, string>) => {
      if (name.startsWith('scenes.')) {
        throw new Error('template not found');
      }
      return `rendered:${name}`;
    });
    const pm = {
      render: renderMock,
      renderBasePrompt: mock(() => 'base-system-prompt'),
    } as any;
    const stage = new PromptAssemblyStage(pm, {} as any);
    const ctx = makeContext('qq-private');

    await stage.execute(ctx);

    const calledNames = renderMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calledNames).toContain('scenes.qq-private.zh.scene');
    expect(calledNames).toContain('llm.reply.system');
  });
});
