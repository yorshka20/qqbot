import 'reflect-metadata';
import { describe, expect, it, vi } from 'bun:test';
import type { AuditEventStore } from '@/conversation/audit/AuditEventStore';
import type { SessionMemoStore } from '@/conversation/memo/SessionMemoStore';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import type { MemoryRetrievalService } from '@/memory/retrieval/MemoryRetrievalService';
import type { RetrievalService } from '@/services/retrieval/RetrievalService';
import type { VKBContextEngine } from '@/services/vkb/VKBContextEngine';
import type { PromptManager } from '../../../prompt/PromptManager';
import { ReplyPipelineContext } from '../../ReplyPipelineContext';
import { ContextEnrichmentStage } from '../ContextEnrichmentStage';

function makeCtx(): ReplyPipelineContext {
  const metadata = new HookMetadataMap();
  metadata.set('sessionId', 'group:10000001');
  metadata.set('sessionType', 'group');
  const hookContext = {
    message: { userId: 20000001, groupId: 10000001, message: '方便面的调料包', sender: { nickname: '测试用户甲' } },
    metadata,
  } as unknown as HookContext;
  return new ReplyPipelineContext(hookContext, new Map());
}

function makeStage(memoryRetrieval: Partial<MemoryRetrievalService>) {
  const retrievalService = {
    isRAGEnabled: () => true,
    vectorSearch: vi.fn(async () => []),
  } as unknown as RetrievalService;
  const promptManager = { render: () => '' } as unknown as PromptManager;
  const vkb = { isEnabled: () => false, fetchGlossary: async () => '' } as unknown as VKBContextEngine;
  const auditEventStore = { render: () => '' } as unknown as AuditEventStore;
  const sessionMemoStore = { render: () => '' } as unknown as SessionMemoStore;
  return new ContextEnrichmentStage(
    memoryRetrieval as MemoryRetrievalService,
    retrievalService,
    promptManager,
    vkb,
    auditEventStore,
    sessionMemoStore,
  );
}

describe('ContextEnrichmentStage — degradation', () => {
  it('drops the memory section when retrieval fails instead of failing the turn', async () => {
    const stage = makeStage({
      getMemoryForReply: vi.fn(async () => {
        throw new Error('Request timeout after 60000ms');
      }),
    });
    const ctx = makeCtx();

    await stage.execute(ctx);

    expect(ctx.memoryContextText).toBe('');
    expect(ctx.retrievedConversationSection).toBe('');
  });

  it('keeps the memory section when retrieval succeeds', async () => {
    const stage = makeStage({
      getMemoryForReply: vi.fn(async () => ({ groupMemoryText: '群里爱吃面', userMemoryText: '甲在国外' })),
    });
    const ctx = makeCtx();

    await stage.execute(ctx);

    expect(ctx.memoryContextText).toContain('群里爱吃面');
    expect(ctx.memoryContextText).toContain('甲在国外');
  });
});
